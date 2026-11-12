import { mulMoney } from "@lacey-factory/shared/money";
import { can, permissionsFor, type Permission } from "@lacey-factory/shared/permissions";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { Authenticate } from "./auth";
import { amazonConfig, emailConfig, shipstationConfig, shopifyConfig } from "./config";
import type { DB } from "./db/types";
import { loadCatalog } from "./domain/catalog";
import { setRollCost } from "./domain/cogs";
import * as cust from "./domain/customers";
import { UserError } from "./domain/errors";
import * as inv from "./domain/invoices";
import * as ord from "./domain/orders";
import * as q from "./domain/queries";
import * as salesSvc from "./domain/sales";
import * as svc from "./domain/services";
import * as steel from "./domain/steel";
import { type AppUser, ensureUser, listUsers, setUserRole } from "./domain/users";
import * as mailbox from "./email/account";
import { type VerifyResult, verifyShipStationSignature } from "./shipstation/webhook";
import { ORDER_TOPICS, parseOrderWebhook, verifyShopifyHmac } from "./shopify/webhook";
import type { GmailNotification } from "./temporal/names";

type Env = { Variables: { user: AppUser; db: DB } };

// ── Input schemas ──
// The web app posts form fields as strings, so numbers are coerced.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");
const ft = z.coerce.number().positive("Must be greater than 0.");
const optionalFt = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().nonnegative().nullable());
const qty = z.coerce.number().int("Whole numbers only.").min(1, "Quantity must be at least 1.");
const dollars = z.coerce.number().nonnegative("Can't be negative.");
const optionalDollars = z.preprocess((v) => (v === "" || v == null ? null : v), dollars.nullable());
const id = z.string().uuid();
const optionalInches = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().positive().nullable());
const boxSize = { lengthIn: optionalInches, widthIn: optionalInches, heightIn: optionalInches };
/** Low-stock alert level; blank = no alert. */
const reorderLevel = z.preprocess(
  (v) => (v === "" || v == null ? null : v),
  z.coerce.number().int("Reorder level must be a whole number.").min(0, "Reorder level can't be negative.").nullable(),
);
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
  /** Start an Amazon order sync now (Temporal). */
  startAmazonSync: () => Promise<"started" | "running">;
  /** A Shopify order webhook arrived: fetch and save that order (Temporal). */
  notifyShopifyOrder: (orderGid: string, webhookId: string) => Promise<void>;
  /** "Pull orders": read Shopify orders updated since a date, or since the last pull. */
  startShopifyPull: (since: string | null) => Promise<"started" | "running">;
  /** A ShipStation webhook arrived: fetch its labels and save them (Temporal). */
  notifyShipStation: (body: unknown, rawBody: string) => Promise<void>;
  /** "Re-check shipments": read ShipStation labels since a date, or since the last re-check. */
  startShipStationPull: (since: string | null) => Promise<"started" | "running">;
  /** Checks a ShipStation webhook signature; tests pass their own key set. */
  verifyShipStation?: (rawBody: string, header: (name: string) => string | undefined) => Promise<VerifyResult>;
};

/** Routes that skip the app login: browser redirect from Google, Pub/Sub pushes and Shopify/ShipStation webhooks (signed). */
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/email/callback",
  "/api/webhooks/gmail",
  "/api/webhooks/shopify",
  "/api/webhooks/shipstation",
]);

const saleSource = z.enum(["amazon", "shopify"], { message: "Pick Amazon or Shopify." });

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
        /** Price of one roll before freight. */
        rollCost: optionalDollars.optional(),
      }),
    )
    .min(1, "Add at least one line."),
);

const steelReviewLines = z.preprocess(
  (v) => (typeof v === "string" ? JSON.parse(v || "[]") : v),
  z
    .array(
      z.object({
        steelItemId: z.string().uuid("Pick an item for every line."),
        qty: z.coerce.number().int("Whole numbers only.").min(1, "Each line needs at least 1."),
        unitCost: dollars,
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

  // Shopify order webhooks, signed with the app's client secret. Reply fast
  // (Shopify waits 5 s); the order is fetched and saved by a Temporal workflow.
  // A non-2xx response makes Shopify retry.
  app.post("/webhooks/shopify", async (c) => {
    const cfg = shopifyConfig();
    if (cfg.mode === "off") return c.json({ error: "Shopify is off." }, 404);
    const raw = await c.req.text();
    if (!cfg.clientSecret || !verifyShopifyHmac(raw, c.req.header("x-shopify-hmac-sha256"), cfg.clientSecret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (c.req.header("x-shopify-shop-domain") !== cfg.shop) return c.json({ error: "Unknown shop" }, 401);
    const topic = c.req.header("x-shopify-topic") ?? "";
    if (!ORDER_TOPICS.has(topic)) return c.body(null, 200);
    const hook = parseOrderWebhook((name) => c.req.header(name), raw);
    if (!hook) return c.json({ error: "No order id" }, 400);
    const db = deps.getDb();
    await ord.markEventReceived(db, "shopify");
    await deps.notifyShopifyOrder(hook.orderGid, hook.webhookId);
    return c.body(null, 200);
  });

  // ShipStation label and shipped webhooks, signed with ShipStation's RSA key.
  // Reply fast (ShipStation waits 10 s); the labels are fetched by a Temporal
  // workflow. A non-2xx response makes ShipStation retry (twice, 30 min apart).
  app.post("/webhooks/shipstation", async (c) => {
    const cfg = shipstationConfig();
    if (cfg.mode === "off") return c.json({ error: "ShipStation is off." }, 404);
    const raw = await c.req.text();
    if (!cfg.skipSignature) {
      const header = (name: string) => c.req.header(name);
      const check = deps.verifyShipStation
        ? await deps.verifyShipStation(raw, header)
        : await verifyShipStationSignature(raw, header, { jwksUrl: cfg.jwksUrl });
      if (!check.ok) return c.json({ error: check.error }, check.status);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "Body isn't JSON" }, 400);
    }
    if (!body || typeof body !== "object") return c.json({ error: "Body isn't an object" }, 400);
    await ord.markEventReceived(deps.getDb(), "shipstation");
    await deps.notifyShipStation(body, raw);
    return c.body(null, 200);
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
    .get("/steel", async (c) => {
      const [items, activity] = await Promise.all([steel.steelSummary(c.var.db), steel.steelActivity(c.var.db)]);
      return c.json({ items, ...activity });
    })
    .get("/sales", async (c) => {
      const rows = await salesSvc.listSales(c.var.db);
      const links = await ord.orderIdsForSales(c.var.db, rows.map((r) => r.sale.id));
      return c.json(rows.map((r) => ({ ...r, order: links.get(r.sale.id) ?? null })));
    })

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
          // "" = same as the material
          sewing: z.enum(["", "sewn", "not_sewn"]).default(""),
        }),
      );
      const { sewing, ...rest } = i;
      await svc.createCutSize(c.var.db, { ...rest, requiresSewing: sewing === "" ? undefined : sewing === "sewn" });
      return ok(c, `Added ${i.label}.`);
    })
    .patch("/cut-sizes/:id", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({ cutLengthFt: ft, productFamily: text, sortOrder: z.coerce.number().int(), active: checkbox, requiresSewing: checkbox }),
      );
      await svc.updateCutSize(c.var.db, param(c, "id"), {
        cutLengthFt: i.cutLengthFt,
        productFamily: i.productFamily?.trim() || null,
        sortOrder: i.sortOrder,
        active: i.active,
        requiresSewing: i.requiresSewing,
      });
      return ok(c, "Saved.");
    })
    .post("/steel-items", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({
          name: z.string().min(1, "Name is required."),
          sortOrder: z.coerce.number().int().default(0),
          kind: z.enum(["steel", "box", "part"]).default("steel"),
          reorderLevel,
          ...boxSize,
        }),
      );
      await steel.createSteelItem(c.var.db, i);
      return ok(c, `Added ${i.name}.`);
    })
    .patch("/steel-items/:id", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({ name: z.string().min(1, "Name is required."), sortOrder: z.coerce.number().int(), active: checkbox, reorderLevel, ...boxSize }),
      );
      await steel.updateSteelItem(c.var.db, param(c, "id"), i);
      return ok(c, "Saved.");
    })
    .post("/products/:id/box", need("settings"), async (c) => {
      const i = await input(c, z.object({ boxId: z.preprocess((v) => (v === "" ? null : v), z.string().uuid().nullable()) }));
      await steel.setProductBox(c.var.db, { productId: param(c, "id"), boxId: i.boxId });
      await ord.retryProblems(c.var.db);
      return ok(c, i.boxId ? "Box saved." : "Box removed.");
    })
    .patch("/products/:id", need("settings"), async (c) => {
      const i = await input(c, z.object({ sku: text, shipWeightLb: optionalFt, sewCostInHouse: optionalDollars, sewCostSummit: optionalDollars }));
      await q.updateProductShipping(c.var.db, param(c, "id"), i);
      return ok(c, "Saved.");
    })
    .post("/products/:id/steel", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({ steelItemId: z.string().uuid("Pick a steel item."), qty: z.coerce.number().int("Whole numbers only.").min(0) }),
      );
      await steel.setProductSteel(c.var.db, { ...i, productId: param(c, "id") });
      // Channel orders that were waiting for this product's recipe can be recorded now.
      await ord.retryProblems(c.var.db);
      return ok(c, i.qty === 0 ? "Removed." : "Saved.");
    })
    .post("/catalog/load", need("settings"), async (c) => {
      const r = await loadCatalog(c.var.db);
      if (r.materials + r.sizes + r.products + r.components + r.suppliers + r.boxes + r.parts === 0) {
        return ok(c, "Catalog already loaded — nothing to add.");
      }
      return ok(
        c,
        `Added ${r.materials} materials, ${r.sizes} sizes (switched off until cut length is set), ${r.products} products, ${r.boxes} boxes, ${r.parts} parts` +
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
    .patch("/rolls/:id/cost", need("settings"), async (c) => {
      const i = await input(c, z.object({ cost: optionalDollars }));
      await setRollCost(c.var.db, param(c, "id"), i.cost);
      return ok(c, i.cost == null ? "Price cleared." : "Price saved. Sales from this roll were re-costed.");
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
    .post("/steel/adjustments", need("inventory:adjust"), async (c) => {
      const i = await input(
        c,
        z.object({
          steelItemId: z.string().uuid("Pick a steel item."),
          qty: z.coerce.number().int("Whole numbers only."),
          reason: z.enum(["opening_balance", "count_correction"]),
          unitCost: optionalDollars,
          adjustedOn: isoDate,
          note: text,
        }),
      );
      await steel.adjustSteel(c.var.db, c.var.user.email, i);
      return ok(c, "Steel adjusted.");
    })

    // ── Sales ──
    .post("/sales", need("sales:record"), async (c) => {
      const i = await input(c, z.object({ productId: z.string().uuid("Pick a product."), qty, soldOn: isoDate, note: text }));
      const { sale } = await salesSvc.recordSale(c.var.db, c.var.user.email, { ...i, source: "manual" });
      return ok(c, sale.short ? "Sale recorded — some steel wasn't in stock." : "Sale recorded.", { id: sale.id });
    })
    .post("/sales/:id/void", need("sales:record"), async (c) => {
      await salesSvc.voidSale(c.var.db, c.var.user.email, param(c, "id"));
      return ok(c, "Sale undone.");
    })

    // ── Channel orders (Amazon, Shopify) and their ShipStation shipments ──
    .get("/orders", need("orders"), async (c) => {
      const f = c.req.query();
      return c.json(
        await ord.listOrders(c.var.db, {
          source: saleSource.safeParse(f.source).data,
          customerId: id.safeParse(f.customerId).data,
          marketplace: f.marketplace || undefined,
          status: f.status || undefined,
          problemsOnly: f.problems === "1",
          q: f.q || undefined,
          before: f.before || undefined,
        }),
      );
    })
    .get("/orders/status", need("orders"), async (c) => {
      const [amazon, shopify, shipstation, problems] = await Promise.all([
        ord.syncState(c.var.db, "amazon"),
        ord.syncState(c.var.db, "shopify"),
        ord.syncState(c.var.db, "shipstation"),
        ord.orderProblems(c.var.db),
      ]);
      return c.json({
        amazon: { mode: amazonConfig().mode, sync: amazon },
        shopify: { mode: shopifyConfig().mode, sync: shopify, shop: shopifyConfig().shop },
        shipstation: { mode: shipstationConfig().mode, sync: shipstation },
        problems,
      });
    })
    .get("/orders/:id", need("orders"), async (c) => {
      const order = await ord.getOrder(c.var.db, param(c, "id"));
      if (!order) throw new HTTPException(404, { message: "Order not found." });
      return c.json(order);
    })
    .post("/orders/sync", need("orders"), async (c) => {
      const i = await input(
        c,
        z.object({
          source: z.preprocess((v) => v ?? "amazon", z.enum(["amazon", "shopify", "shipstation"], { message: "Pick what to sync." })),
          since: z.preprocess((v) => (v === "" || v == null ? null : v), isoDate.nullable()),
        }),
      );
      if (i.source === "shipstation") {
        if (shipstationConfig().mode === "off") throw new UserError("ShipStation is off. Set SHIPSTATION_MODE in .env.");
        const r = await deps.startShipStationPull(i.since);
        return ok(c, r === "running" ? "A re-check is already running." : "Re-checking ShipStation shipments… refresh in a moment.");
      }
      if (i.source === "shopify") {
        if (shopifyConfig().mode === "off") throw new UserError("Shopify is off. Set SHOPIFY_MODE in .env.");
        const r = await deps.startShopifyPull(i.since);
        return ok(c, r === "running" ? "A pull is already running." : "Pulling Shopify orders… refresh in a moment.");
      }
      if (amazonConfig().mode === "off") throw new UserError("Amazon is off. Set AMAZON_MODE in .env.");
      const r = await deps.startAmazonSync();
      return ok(c, r === "running" ? "A sync is already running." : "Syncing Amazon orders… refresh in a moment.");
    })
    .get("/customers", need("orders"), async (c) => c.json(await cust.listCustomers(c.var.db, { q: c.req.query("q") })))
    .get("/customers/:id", need("orders"), async (c) => {
      const customer = await cust.getCustomer(c.var.db, param(c, "id"));
      if (!customer) throw new HTTPException(404, { message: "Customer not found." });
      return c.json(customer);
    })
    .get("/channel-skus", need("orders"), async (c) => c.json(await ord.listChannelSkus(c.var.db)))
    .post("/channel-skus", need("orders"), async (c) => {
      const i = await input(
        c,
        z.object({
          source: z.preprocess((v) => v || "amazon", saleSource),
          sku: z.string().trim().min(1, "Enter the SKU."),
          // "" or "ignore" = not a factory product
          productId: z.preprocess((v) => (v === "" || v === "ignore" ? null : v), z.string().uuid("Pick a product.").nullable()),
          qtyPerUnit: z.preprocess((v) => (v === "" || v == null ? 1 : v), qty),
          note: text,
        }),
      );
      const retried = await ord.mapSku(c.var.db, c.var.user.email, i);
      const what = i.productId ? `Linked ${i.sku}.` : `${i.sku} marked as not a factory product.`;
      return ok(c, retried ? `${what} Updated ${retried} waiting order${retried === 1 ? "" : "s"}.` : what);
    })
    .post("/channel-skus/:id/delete", need("orders"), async (c) => {
      await ord.removeChannelSku(c.var.db, param(c, "id"));
      return ok(c, "SKU link removed.");
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
      const i = await input(c, z.object({ receivedOn: isoDate, lines: reviewLines, freight: optionalDollars }));
      const planned: inv.PlannedRoll[] = [];
      for (const [line, l] of i.lines.entries()) {
        const numbers = l.rollNumbers.split(/[\s,]+/).filter(Boolean);
        if (numbers.length && numbers.length !== l.count) {
          throw new UserError(`A line has ${l.count} rolls but ${numbers.length} roll numbers.`);
        }
        for (let n = 0; n < l.count; n++) {
          planned.push({
            materialId: l.materialId,
            widthFt: l.widthFt,
            lengthFt: l.lengthFt,
            supplierRollNo: numbers[n] ?? null,
            unitCost: l.rollCost ?? null,
            line,
          });
        }
      }
      const r = await inv.registerRolls(c.var.db, param(c, "id"), planned, {
        actor: c.var.user.email,
        receivedOn: i.receivedOn,
        reviewedBy: c.var.user.email,
        freight: i.freight,
      });
      if (r.status === "duplicate") return ok(c, "This invoice was already registered from another email.");
      return ok(c, `Registered ${r.rollIds.length} roll${r.rollIds.length === 1 ? "" : "s"}.`);
    })
    .post("/documents/:id/receive-steel", need("invoices:review"), async (c) => {
      const i = await input(c, z.object({ receivedOn: isoDate, freight: dollars, lines: steelReviewLines }));
      const r = await steel.receiveSteel(
        c.var.db,
        param(c, "id"),
        {
          freight: i.freight,
          lines: i.lines.map((l) => ({ ...l, label: "", amount: mulMoney(l.qty, l.unitCost) })),
        },
        { actor: c.var.user.email, receivedOn: i.receivedOn, reviewedBy: c.var.user.email },
      );
      if (r.status === "duplicate") return ok(c, "This invoice was already registered from another email.");
      const n = i.lines.reduce((a, l) => a + l.qty, 0);
      const w = steel.stockWords(r.stockKind);
      return ok(c, `Added ${n} ${n === 1 ? w.one : w.many} to ${w.stock}.`);
    })
    .post("/documents/:id/dismiss", need("invoices:review"), async (c) => {
      const doc = await inv.getDocument(c.var.db, param(c, "id"));
      if (!doc) throw new HTTPException(404, { message: "Document not found." });
      if (doc.status === "registered") throw new UserError("This document was already registered.");
      await inv.setDocumentStatus(c.var.db, doc.id, "not_invoice", "Marked as not an invoice we track.", c.var.user.email);
      return ok(c, "Marked as not an invoice we track.");
    })

    // ── Suppliers (settings) ──
    .get("/suppliers", need("settings"), async (c) => c.json(await inv.listSuppliers(c.var.db)))
    .post("/suppliers", need("settings"), async (c) => {
      const i = await input(
        c,
        z.object({ name: z.string().min(1, "Name is required."), emailPatterns: z.string(), kind: z.enum(["rolls", "steel", "boxes"]).default("rolls") }),
      );
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
    .post("/suppliers/:id/steel-products", need("settings"), async (c) => {
      const i = await input(c, z.object({ productCode: text, descriptionMatch: text, steelItemId: z.string().uuid("Pick a pole or box.") }));
      await steel.addSupplierSteelProduct(c.var.db, { ...i, supplierId: param(c, "id") });
      return ok(c, "Product added.");
    })
    .post("/supplier-steel-products/:id/delete", need("settings"), async (c) => {
      await steel.removeSupplierSteelProduct(c.var.db, param(c, "id"));
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
