import { can, permissionsFor, type Permission } from "@lacey-factory/shared/permissions";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { Authenticate } from "./auth";
import type { DB } from "./db/types";
import { loadCatalog } from "./domain/catalog";
import { UserError } from "./domain/errors";
import * as q from "./domain/queries";
import * as svc from "./domain/services";
import { type AppUser, ensureUser, listUsers, setUserRole } from "./domain/users";

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

export function createApp(deps: { getDb: () => DB; authenticate: Authenticate }) {
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

  // Everything below needs a signed-in, allowed user.
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
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
      if (r.materials + r.sizes + r.products + r.components === 0) {
        return ok(c, "Catalog already loaded — nothing to add.");
      }
      return ok(
        c,
        `Added ${r.materials} materials, ${r.sizes} sizes (switched off until cut length is set), ${r.products} products.`,
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

    // ── Users (admin) ──
    .get("/users", need("users"), async (c) => c.json(await listUsers(c.var.db)))
    .patch("/users/:id", need("users"), async (c) => {
      const i = await input(c, z.object({ role: z.enum(["factory", "regular"], "Pick a role.") }));
      const u = await setUserRole(c.var.db, c.var.user.email, param(c, "id"), i.role);
      return ok(c, `${u.email} is now a ${i.role === "regular" ? "regular" : "factory"} worker.`);
    });

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
