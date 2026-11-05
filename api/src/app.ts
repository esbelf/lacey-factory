import { can, permissionsFor, type Permission } from "@lacey-factory/shared/permissions";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { Authenticate } from "./auth";
import { emailConfig } from "./config";
import type { DB } from "./db/types";
import { loadCatalog } from "./domain/catalog";
import { UserError } from "./domain/errors";
import * as inv from "./domain/invoices";
import * as q from "./domain/queries";
import * as svc from "./domain/services";
import { type AppUser, ensureUser, listUsers, setUserRole } from "./domain/users";
import * as mailbox from "./email/account";
import type { GmailNotification } from "./temporal/names";

type Env = { Variables: { user: AppUser; db: DB } };

// ── Input schemas ──
// The web app posts form fields as strings, so numbers are coerced.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");
const ft = z.coerce.number().positive("Must be greater than 0.");
const optionalFt = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().nonnegative().nullable());
const qty = z.coerce.number().int("Whole numbers only.").min(1, "Quantity must be at least 1.");
const id = z.string().uuid();
const text = z.string().optional().nullable();
const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());
const lines = z.preprocess(
  (v) => (typeof v === "string" ? JSON.parse(v || "[]") : v),
  z.array(z.object({ cutSizeId: id, qty })),
);

async function input<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Check the form.");
  return parsed.data;
}

/** Route param that must be a UUID; anything else is a 404. */
function param(c: Context, name: string): string {
  const v = c.req.param(name);
  if (!v || !id.safeParse(v).success) throw new HTTPException(404, { message: "Not found." });
  return v;
}

const ok = (c: Context, message: string, extra: Record<string, unknown> = {}) => c.json({ ok: message, ...extra });

export type AppDeps = {
  getDb: () => DB;
  authenticate: Authenticate;
  /** Wake the mailbox workflow (Temporal signal-with-start). */
  notifyMailbox: (n: GmailNotification) => Promise<void>;
  /** Verify the Google-signed OIDC token on a Pub/Sub push. */
  verifyPushToken: (token: string) => Promise<boolean>;
  /** Short-lived link to a stored document. */
  documentUrl: (key: string) => Promise<string>;
};

/** Routes that skip the app login: browser redirect from Google, and Pub/Sub pushes. */
const PUBLIC_PATHS = new Set(["/api/health", "/api/email/callback", "/api/webhooks/gmail"]);

const reviewLines = z.preprocess(
  (v) => (typeof v === "string" ? JSON.parse(v || "[]") : v),
  z
    .array(
      z.object({
        materialId: z.string().uuid("Pick a material for every line."),
        widthFt: z.coerce.number().positive("Width must be greater than 0."),
        lengthFt: z.coerce.number().positive("Length must be greater than 0."),
        count: z.coerce.number().int("Whole numbers only.").min(1, "Each line needs at least 1 roll."),
        rollNumbers: z.string().optional().default(""),
      }),
    )
    .min(1, "Add at least one line."),
);

export function createApp(deps: AppDeps) {
  const need = (p: Permission) =>
    createMiddleware<Env>(async (c, next) => {
      if (!can(c.var.user.role, p)) {
        return c.json({ error: "You don't have permission to do that. Ask Eric if you need it." }, 403);
      }
      await next();
    });

  const app = new Hono<Env>().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, 400);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Something went wrong. Try again." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // Google sends the browser back here after "Connect Email". Authenticated by
  // the one-time state created when the admin clicked Connect.
  app.get("/email/callback", async (c) => {
    const base = emailConfig().appBaseUrl;
    const { state, code, error } = c.req.query();
    const fail = (message: string) => c.redirect(`${base}/inbox?email=error&message=${encodeURIComponent(message)}`);
    if (error) return fail(error === "access_denied" ? "Access wasn't granted." : error);
    if (!state || !code) return fail("Google didn't send back a code.");
    try {
      await mailbox.finishConnect(deps.getDb(), { state, code });
    } catch (err) {
      if (err instanceof UserError) return fail(err.message);
      console.error(err);
      return fail("Connecting failed. Try again.");
    }
    return c.redirect(`${base}/inbox?email=connected`);
  });

  // Gmail → Pub/Sub push. A non-2xx response makes Pub/Sub retry.
  app.post("/webhooks/gmail", async (c) => {
    if (emailConfig().pubsubMode !== "push") return c.json({ error: "Push delivery is off." }, 404);
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token || !(await deps.verifyPushToken(token))) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ message?: { data?: string } }>().catch(() => ({}) as { message?: { data?: string } });
    if (!body.message?.data) return c.json({ error: "Bad request" }, 400);
    await handleNotification(deps, decodePubSubData(body.message.data));
    return c.body(null, 204);
  });

  // Everything below needs a signed-in, allowed user.
  app.use("*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const who = await deps.authenticate(c.req.raw);
    if (who === null) return c.json({ error: "Sign in required." }, 401);
    if (who === "denied") return c.json({ error: "This app is for the LakeMat team only." }, 403);
    const db = deps.getDb();
    c.set("db", db);
    c.set("user", await ensureUser(db, who));
    await next();
  });

  const routes = app
    .get("/me", (c) => {
      const u = c.var.user;
      return c.json({ email: u.email, name: u.name, role: u.role, permissions: permissionsFor(u.role) });
    })

    // ── Reads (any signed-in user) ──
    .get("/materials", async (c) => c.json(await q.listMaterials(c.var.db)))
    .get("/cut-sizes", async (c) => c.json(await q.listCutSizes(c.var.db)))
    .get("/products", async (c) => c.json(await q.listProducts(c.var.db)))
    .get("/rolls", async (c) => c.json(await q.listRolls(c.var.db)))
    .get("/rolls/:id", async (c) => {
      const roll = await q.getRoll(c.var.db, param(c, "id"));
      if (!roll) throw new HTTPException(404, { message: "Roll not found." });
      return c.json(roll);
    })
    .get("/pipeline", async (c) => c.json(await q.pipelineBySize(c.var.db)))
    .get("/activity", async (c) => c.json(await q.recentActivity(c.var.db)))
    .get("/adjustments", async (c) => c.json(await q.recentAdjustments(c.var.db)))

    // ── Settings ──
    .post("/materials", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({ name: z.string().min(1, "Name is required."), requiresSewing: checkbox, defaultWidthFt: optionalFt }),
      );
      await svc.createMaterial(c.var.db, i);
      return ok(c, `Added ${i.name}.`);
    })
    .patch("/materials/:id", need("settings"), async (c) => {
      const i = await input(c, z.object({ active: z.preprocess((v) => v === true || v === "true", z.boolean()) }));
      await svc.setMaterialActive(c.var.db, param(c, "id"), i.active);
      return ok(c, "Saved.");
    })
    .post("/cut-sizes", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({
          materialId: id,
          label: z.string().min(1, "Label is required."),
          widthFt: ft,
          cutLengthFt: ft,
          productFamily: text,
          sortOrder: z.coerce.number().int().default(0),
        }),
      );
      await svc.createCutSize(c.var.db, i);
      return ok(c, `Added ${i.label}.`);
    })
    .patch("/cut-sizes/:id", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({ cutLengthFt: ft, productFamily: text, sortOrder: z.coerce.number().int(), active: checkbox }),
      );
      await svc.updateCutSize(c.var.db, param(c, "id"), {
        cutLengthFt: i.cutLengthFt,
        productFamily: i.productFamily?.trim() || null,
        sortOrder: i.sortOrder,
        active: i.active,
      });
      return ok(c, "Saved.");
    })
    .post("/catalog/load", need("settings"), async (c) => {
      const r = await loadCatalog(c.var.db);
      if (r.materials + r.sizes + r.products + r.components + r.suppliers === 0) {
        return ok(c, "Catalog already loaded — nothing to add.");
      }
      return ok(
        c,
        `Added ${r.materials} materials, ${r.sizes} sizes (switched off until cut length is set), ${r.products} products` +
          (r.suppliers ? `, ${r.suppliers} supplier (add its email addresses under Suppliers).` : "."),
      );
    })

    // ── Rolls & cutting ──
    .post("/rolls", need("floor"), async (c) => {
      const i = await input(
        c,
        z.object({
          materialId: z.string().uuid("Pick a material."),
          supplierRollNo: text,
          supplier: text,
          widthFt: ft,
          lengthFt: ft,
          receivedOn: isoDate,
          notes: text,
        }),
      );
      const roll = await svc.createRoll(c.var.db, c.var.user.email, i);
      return ok(c, `Registered ${roll.appCode}.`, { id: roll.id });
    })
    .post("/rolls/:id/cuts", need("floor"), async (c) => {
      const i = await input(c, z.object({ cutOn: isoDate, lines, notes: text }));
      const cutLines = i.lines.filter((l) => l.qty > 0);
      const r = await svc.recordCut(c.var.db, c.var.user.email, { ...i, rollId: param(c, "id"), lines: cutLines });
      const n = cutLines.reduce((a, l) => a + l.qty, 0);
      return ok(c, `Recorded ${n} piece${n === 1 ? "" : "s"}. ${r.remainingAfter}' left on the roll.`);
    })
    .post("/cuts/:id/void", need("undo"), async (c) => {
      await svc.voidCutSession(c.var.db, c.var.user.email, param(c, "id"));
      return ok(c, "Cut undone.");
    })
    .post("/rolls/:id/close", need("rolls:close"), async (c) => {
      const i = await input(c, z.object({ closedOn: isoDate, leftoverFtMeasured: optionalFt }));
      await svc.closeRoll(c.var.db, { ...i, rollId: param(c, "id") });
      return ok(c, "Roll closed out.");
    })
    .post("/rolls/:id/reopen", need("rolls:close"), async (c) => {
      await svc.reopenRoll(c.var.db, param(c, "id"));
      return ok(c, "Roll reopened.");
    })

    // ── Sewing & Summit ──
    .post("/sewing", need("floor"), async (c) => {
      const i = await input(c, z.object({ cutSizeId: id, qty, date: isoDate }));
      await svc.markSewnInHouse(c.var.db, c.var.user.email, {
        sewnOn: i.date,
        lines: [{ cutSizeId: i.cutSizeId, qty: i.qty }],
      });
      return ok(c, `${i.qty} marked sewn → inventory.`);
    })
    .post("/sewing/:id/void", need("undo"), async (c) => {
      await svc.voidSewBatch(c.var.db, c.var.user.email, param(c, "id"));
      return ok(c, "Sewing entry undone.");
    })
    .post("/summit/shipments", need("floor"), async (c) => {
      const i = await input(c, z.object({ cutSizeId: id, qty, date: isoDate }));
      await svc.sendToSummit(c.var.db, c.var.user.email, {
        sentOn: i.date,
        lines: [{ cutSizeId: i.cutSizeId, qty: i.qty }],
      });
      return ok(c, `${i.qty} sent to Summit.`);
    })
    .post("/summit/shipments/:id/void", need("undo"), async (c) => {
      await svc.voidSummitShipment(c.var.db, c.var.user.email, param(c, "id"));
      return ok(c, "Shipment undone.");
    })
    .post("/summit/receipts", need("floor"), async (c) => {
      const i = await input(c, z.object({ cutSizeId: id, qty, date: isoDate, notes: text }));
      await svc.receiveFromSummit(c.var.db, c.var.user.email, {
        cutSizeId: i.cutSizeId,
        qty: i.qty,
        receivedOn: i.date,
        notes: i.notes,
      });
      return ok(c, `${i.qty} received from Summit → inventory.`);
    })
    .post("/summit/receipts/:id/void", need("undo"), async (c) => {
      await svc.voidSummitReceipt(c.var.db, c.var.user.email, param(c, "id"));
      return ok(c, "Receipt undone.");
    })

    // ── Inventory ──
    .post("/inventory/adjustments", need("inventory:adjust"), async (c) => {
      const i = await input(
        c,
        z.object({
          cutSizeId: z.string().uuid("Pick a size."),
          qty: z.coerce.number().int("Whole numbers only."),
          reason: z.enum(["opening_balance", "count_correction", "sale", "other"]),
          adjustedOn: isoDate,
          note: text,
        }),
      );
      await svc.adjustInventory(c.var.db, c.var.user.email, i);
      return ok(c, "Inventory adjusted.");
    })

    // ── Supplier email (admin) ──
    .get("/email/status", need("email:connect"), async (c) => c.json(await mailbox.accountStatus(c.var.db)))
    .post("/email/connect", need("email:connect"), async (c) =>
      c.json({ ok: "Opening Google…", url: await mailbox.startConnect(c.var.db, c.var.user.email) }),
    )
    .post("/email/disconnect", need("email:connect"), async (c) => {
      await mailbox.disconnect(c.var.db);
      return ok(c, "Email disconnected.");
    })

    // ── Supplier documents (inbox) ──
    .get("/documents", need("invoices:review"), async (c) => c.json(await inv.listDocuments(c.var.db)))
    .get("/documents/:id/file", need("invoices:review"), async (c) => {
      const doc = await inv.getDocument(c.var.db, param(c, "id"));
      if (!doc) throw new HTTPException(404, { message: "Document not found." });
      return c.json({ url: await deps.documentUrl(doc.s3Key) });
    })
    .post("/documents/:id/register", need("invoices:review"), async (c) => {
      const i = await input(c, z.object({ receivedOn: isoDate, lines: reviewLines }));
      const planned: inv.PlannedRoll[] = [];
      for (const l of i.lines) {
        const numbers = l.rollNumbers.split(/[\s,]+/).filter(Boolean);
        if (numbers.length && numbers.length !== l.count) {
          throw new UserError(`A line has ${l.count} rolls but ${numbers.length} roll numbers.`);
        }
        for (let n = 0; n < l.count; n++) {
          planned.push({ materialId: l.materialId, widthFt: l.widthFt, lengthFt: l.lengthFt, supplierRollNo: numbers[n] ?? null });
        }
      }
      const r = await inv.registerRolls(c.var.db, param(c, "id"), planned, {
        actor: c.var.user.email,
        receivedOn: i.receivedOn,
        reviewedBy: c.var.user.email,
      });
      if (r.status === "duplicate") return ok(c, "This invoice was already registered from another email.");
      return ok(c, `Registered ${r.rollIds.length} roll${r.rollIds.length === 1 ? "" : "s"}.`);
    })
    .post("/documents/:id/dismiss", need("invoices:review"), async (c) => {
      const doc = await inv.getDocument(c.var.db, param(c, "id"));
      if (!doc) throw new HTTPException(404, { message: "Document not found." });
      if (doc.status === "registered") throw new UserError("Rolls were already registered from this document.");
      await inv.setDocumentStatus(c.var.db, doc.id, "not_invoice", "Marked as not a roll invoice.", c.var.user.email);
      return ok(c, "Marked as not a roll invoice.");
    })

    // ── Suppliers (settings) ──
    .get("/suppliers", need("settings"), async (c) => c.json(await inv.listSuppliers(c.var.db)))
    .post("/suppliers", need("settings"), async (c) => {
      const i = await input(c, z.object({ name: z.string().min(1, "Name is required."), emailPatterns: z.string() }));
      await inv.saveSupplier(c.var.db, i);
      return ok(c, `Saved ${i.name}.`);
    })
    .patch("/suppliers/:id", need("settings"), async (c) => {
      const i = await input(c, z.object({ name: z.string().min(1, "Name is required."), emailPatterns: z.string(), active: checkbox }));
      await inv.saveSupplier(c.var.db, { ...i, id: param(c, "id") });
      return ok(c, "Saved.");
    })
    .post("/suppliers/:id/products", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({ productCode: text, descriptionMatch: text, materialId: z.string().uuid("Pick a material."), widthFt: ft, lengthFt: ft }),
      );
      await inv.addSupplierProduct(c.var.db, { ...i, supplierId: param(c, "id") });
      return ok(c, "Product added.");
    })
    .post("/supplier-products/:id/delete", need("settings"), async (c) => {
      await inv.removeSupplierProduct(c.var.db, param(c, "id"));
      return ok(c, "Product removed.");
    })

    // ── Users (admin) ──
    .get("/users", need("users"), async (c) => c.json(await listUsers(c.var.db)))
    .patch("/users/:id", need("users"), async (c) => {
      const i = await input(c, z.object({ role: z.enum(["factory", "regular"], "Pick a role.") }));
      const u = await setUserRole(c.var.db, c.var.user.email, param(c, "id"), i.role);
      return ok(c, `${u.email} is now a ${i.role === "regular" ? "regular" : "factory"} worker.`);
    });

  return routes;
}

/** Shared by the push webhook and the local Pub/Sub pull loop. Unknown mailboxes are ignored. */
export async function handleNotification(deps: Pick<AppDeps, "getDb" | "notifyMailbox">, n: GmailNotification) {
  const email = n.emailAddress?.toLowerCase();
  if (!email || !n.historyId) return false;
  const account = await mailbox.getAccount(deps.getDb(), email);
  if (account?.status !== "connected") {
    console.warn(`Ignoring Gmail notification for ${email} (not connected).`);
    return false;
  }
  await deps.notifyMailbox({ emailAddress: email, historyId: String(n.historyId) });
  return true;
}

export function decodePubSubData(data: string | Buffer): GmailNotification {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data, "base64").toString("utf8");
  return JSON.parse(text) as GmailNotification;
}

export type AppType = ReturnType<typeof createApp>;
