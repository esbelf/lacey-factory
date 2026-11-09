// Shopify orders: reading the GraphQL order, webhooks, customers across orders, and sales.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { getCustomer, listCustomers } from "../src/domain/customers";
import { getOrder, listOrders, mapSku, syncState } from "../src/domain/orders";
import * as svc from "../src/domain/services";
import { adjustSteel, createSteelItem, setProductSteel, steelSummary } from "../src/domain/steel";
import { ShopifyAdmin, ShopifyError } from "../src/shopify/admin-api";
import { fakeShopifyOrder, SAMPLE_CUSTOMERS, SAMPLE_SKUS } from "../src/shopify/fake-orders";
import { normalizeShopifyOrder } from "../src/shopify/normalize";
import { FakeShopifySource } from "../src/shopify/order-source";
import { ingestOrder, ingestOrderById, pullBegin, pullEnd, pullPage } from "../src/shopify/sync";
import type { ShopifyOrder } from "../src/shopify/types";
import { parseOrderWebhook, signShopifyBody, verifyShopifyHmac } from "../src/shopify/webhook";

const ME = "eric@lakemat.com";
const xl = [{ sku: SAMPLE_SKUS.lakeMatXL, qty: 1, price: 399.99 }];

describe("normalizeShopifyOrder", () => {
  it("keeps tax lines, money, both addresses and the customer", () => {
    const o = fakeShopifyOrder({ id: 101, number: 1001, region: "MI", customer: SAMPLE_CUSTOMERS.pat, shipping: 25, items: xl });
    const { order, items, customer } = normalizeShopifyOrder(o);
    expect(order).toMatchObject({
      source: "shopify",
      externalId: "gid://shopify/Order/101",
      orderName: "#1001",
      marketplace: "US",
      status: "PAID",
      currency: "USD",
      subtotal: 399.99,
      shippingCharged: 25,
      discountTotal: 0,
      taxTotal: 25.5, // 6% of 424.99
      orderTotal: 450.49,
      taxLines: [{ title: "Michigan State Tax", rate: 0.06, amount: 25.5 }],
      email: "pat.walsh@example.com",
      shipCity: "Traverse City",
      shipState: "MI",
      shipCountry: "US",
      canceledAt: null,
    });
    expect(order.shippingAddress).toMatchObject({ name: "Pat Walsh", address1: "123 Lakeshore Dr", zip: "49684", countryCode: "US" });
    expect(order.billingAddress).toMatchObject({ city: "Traverse City" });
    expect(order.raw).toBe(o);
    expect(items[0]).toMatchObject({ sku: "LM-XL", qtyOrdered: 1, itemPrice: 399.99, itemTax: 24 });
    expect(customer).toEqual({ externalId: "gid://shopify/Customer/7001", email: "pat.walsh@example.com", firstName: "Pat", lastName: "Walsh", phone: "+12315550101" });
  });

  it("keeps each Canadian tax separately", () => {
    const { order } = normalizeShopifyOrder(fakeShopifyOrder({ region: "BC", customer: SAMPLE_CUSTOMERS.renee, items: xl }));
    expect(order.taxLines).toEqual([
      { title: "GST", rate: 0.05, amount: 20 },
      { title: "BC PST", rate: 0.07, amount: 28 },
    ]);
    expect(order.taxTotal).toBe(48);
    expect(order.shipCountry).toBe("CA");
  });

  it("names a guest from the billing address", () => {
    const { customer } = normalizeShopifyOrder(fakeShopifyOrder({ region: "OH", customer: SAMPLE_CUSTOMERS.sam, items: xl }));
    expect(customer).toMatchObject({ externalId: null, email: "sam.k@example.com", firstName: "Sam", lastName: "Kowalski" });
  });
});

describe("webhook signatures", () => {
  it("accepts Shopify's signature and nothing else", () => {
    const body = JSON.stringify({ id: 5, admin_graphql_api_id: "gid://shopify/Order/5" });
    const sig = signShopifyBody(body, "shh");
    expect(verifyShopifyHmac(body, sig, "shh")).toBe(true);
    expect(verifyShopifyHmac(body, sig, "other")).toBe(false);
    expect(verifyShopifyHmac(`${body} `, sig, "shh")).toBe(false);
    expect(verifyShopifyHmac(body, undefined, "shh")).toBe(false);
    expect(verifyShopifyHmac(body, "short", "shh")).toBe(false);
  });

  it("reads the order id from the body", () => {
    const h = (n: string) => ({ "x-shopify-topic": "orders/paid", "x-shopify-webhook-id": "w1" })[n];
    expect(parseOrderWebhook(h, JSON.stringify({ id: 5 }))).toMatchObject({ orderGid: "gid://shopify/Order/5", webhookId: "w1", topic: "orders/paid" });
    expect(parseOrderWebhook(h, "not json")).toBeNull();
  });
});

describe("ShopifyAdmin", () => {
  it("logs in with client credentials once and reports throttling as retryable", async () => {
    const calls: string[] = [];
    const responses = [
      { status: 200, body: { access_token: "tok", expires_in: 86399 } },
      { status: 200, body: { data: { order: { id: "gid://shopify/Order/1" } } } },
      { status: 200, body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } },
    ];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${url} ${init?.headers ? JSON.stringify(init.headers) : ""}`);
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as typeof fetch;
    const api = new ShopifyAdmin({ shop: "lakemat-2.myshopify.com", clientId: "id", clientSecret: "s", apiVersion: "2026-01", fetch: fetchFn });
    expect(await api.getOrder("gid://shopify/Order/1")).toEqual({ id: "gid://shopify/Order/1" });
    const err = await api.getOrder("gid://shopify/Order/1").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyError);
    expect(err.retryable).toBe(true);
    expect(calls[0]).toContain("https://lakemat-2.myshopify.com/admin/oauth/access_token");
    expect(calls[1]).toContain("/admin/api/2026-01/graphql.json");
    expect(calls[1]).toContain('"x-shopify-access-token":"tok"');
    expect(calls).toHaveLength(3); // one login
  });
});

describe("Shopify orders become sales and customers", () => {
  let db: DB;
  let gridSize: string;
  let pole: string;
  let lakeMat: string;

  const items = (orderId: string) => db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId));
  const poles = async () => (await steelSummary(db)).find((s) => s.id === pole)!.onHand;
  const orderFor = async (o: ShopifyOrder) => (await listOrders(db, { source: "shopify", q: o.name.slice(1) })).orders[0];
  const later = (o: ShopifyOrder, changes: Partial<ShopifyOrder>, minutes = 5): ShopifyOrder => ({
    ...o,
    ...changes,
    updatedAt: new Date(new Date(o.updatedAt).getTime() + minutes * 60_000).toISOString(),
  });

  beforeAll(async () => {
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    db = pg as unknown as DB;

    const grid = await svc.createMaterial(db, { name: "Geogrid", requiresSewing: false });
    gridSize = (await svc.createCutSize(db, { materialId: grid.id, label: "12x24", widthFt: 12, cutLengthFt: 24 })).id;
    const roll = await svc.createRoll(db, ME, { materialId: grid.id, widthFt: 12, lengthFt: 300, receivedOn: "2026-09-01" });
    await svc.recordCut(db, ME, { rollId: roll.id, cutOn: "2026-09-02", lines: [{ cutSizeId: gridSize, qty: 10 }] });
    pole = (await createSteelItem(db, { name: "Long" })).id;
    await adjustSteel(db, ME, { steelItemId: pole, qty: 100, reason: "opening_balance", unitCost: 10, adjustedOn: "2026-09-01" });
    [{ id: lakeMat }] = await db.insert(schema.products).values({ name: "LakeMat XL", productLine: "LakeMat" }).returning();
    await db.insert(schema.productComponents).values({ productId: lakeMat, cutSizeId: gridSize, qty: 1 });
    await setProductSteel(db, { productId: lakeMat, steelItemId: pole, qty: 4 });
    await mapSku(db, ME, { source: "shopify", sku: SAMPLE_SKUS.lakeMatXL, productId: lakeMat, qtyPerUnit: 1 });
  });

  it("records a paid order once, with its customer", async () => {
    const o = fakeShopifyOrder({ id: 201, number: 2001, region: "MI", customer: SAMPLE_CUSTOMERS.pat, createdAt: "2026-09-15T15:00:00Z", items: xl });
    expect(await ingestOrder(db, o)).toBe("saved");
    const saved = await orderFor(o);
    expect(saved).toMatchObject({ orderName: "#2001", taxTotal: 24, customerName: "Pat Walsh" });
    const [item] = await items(saved.id);
    expect(item.state).toBe("recorded");
    const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, item.saleId!));
    expect(sale).toMatchObject({ source: "shopify", soldOn: "2026-09-15", note: "Shopify order #2001" });
    expect(await poles()).toBe(96);
    expect(await svc.onHand(db, gridSize)).toBe(9);

    // The same webhook twice, or an update: no second sale.
    expect(await ingestOrder(db, o)).toBe("unchanged");
    await ingestOrder(db, later(o, { displayFulfillmentStatus: "FULFILLED" }));
    expect(await poles()).toBe(96);
  });

  it("a repeat customer is one customer with both orders", async () => {
    const second = fakeShopifyOrder({ id: 202, number: 2002, region: "MI", customer: SAMPLE_CUSTOMERS.pat, createdAt: "2026-11-01T15:00:00Z", items: xl });
    await ingestOrder(db, second);
    const pats = await listCustomers(db, { q: "walsh" });
    expect(pats).toHaveLength(1);
    expect(pats[0]).toMatchObject({ orderCount: 2, customer: { email: "pat.walsh@example.com", firstName: "Pat" } });
    const detail = await getCustomer(db, pats[0].customer.id);
    expect(detail!.orders.map((x) => x.orderName)).toEqual(["#2002", "#2001"]);
    expect(new Date(detail!.firstOrderAt!).toISOString()).toBe("2026-09-15T15:00:00.000Z");
    expect(detail!.spent).toEqual({ USD: 847.98 });
  });

  it("guest checkouts with the same email (any capitals) join the same customer", async () => {
    await ingestOrder(db, fakeShopifyOrder({ id: 203, region: "OH", customer: SAMPLE_CUSTOMERS.sam, items: xl }));
    await ingestOrder(db, fakeShopifyOrder({ id: 204, region: "OH", customer: { ...SAMPLE_CUSTOMERS.sam, email: " SAM.K@Example.com " }, items: xl }));
    // Later Sam makes an account: still the same person.
    await ingestOrder(db, fakeShopifyOrder({ id: 205, region: "OH", customer: { ...SAMPLE_CUSTOMERS.sam, id: "gid://shopify/Customer/7999" }, items: xl }));
    const sams = await listCustomers(db, { q: "sam.k" });
    expect(sams).toHaveLength(1);
    expect(sams[0].orderCount).toBe(3);
    const links = await db.select().from(schema.customerLinks).where(eq(schema.customerLinks.customerId, sams[0].customer.id));
    expect(links.map((l) => l.externalId)).toEqual(["gid://shopify/Customer/7999"]);
  });

  it("skips unpaid orders until they're paid", async () => {
    const o = fakeShopifyOrder({ id: 206, number: 2006, region: "ON", customer: SAMPLE_CUSTOMERS.renee, status: "PENDING", items: xl });
    expect(await ingestOrder(db, o)).toBe("skipped");
    expect(await orderFor(o)).toBeUndefined();
    const before = await poles();
    expect(await ingestOrder(db, later(o, { displayFinancialStatus: "PAID" }))).toBe("saved");
    expect((await orderFor(o)).taxLines).toEqual([{ title: "HST", rate: 0.13, amount: 52 }]);
    expect(await poles()).toBe(before - 4);
  });

  it("a refund or cancel undoes the sale; an older copy can't bring it back", async () => {
    const o = fakeShopifyOrder({ id: 207, number: 2007, region: "MI", customer: SAMPLE_CUSTOMERS.pat, items: xl });
    await ingestOrder(db, o);
    const before = await poles();
    await ingestOrder(db, later(o, { displayFinancialStatus: "REFUNDED" }));
    const saved = await orderFor(o);
    expect((await items(saved.id))[0].state).toBe("canceled");
    expect(await poles()).toBe(before + 4);
    expect(await ingestOrder(db, o)).toBe("unchanged"); // the paid copy arrives late
    expect(await poles()).toBe(before + 4);

    const c = fakeShopifyOrder({ id: 208, number: 2008, region: "MI", customer: SAMPLE_CUSTOMERS.pat, items: xl });
    await ingestOrder(db, c);
    await ingestOrder(db, later(c, { cancelledAt: new Date().toISOString() }));
    expect((await items((await orderFor(c)).id))[0].state).toBe("canceled");
    expect(await poles()).toBe(before + 4);
  });

  it("an unknown SKU waits for a Shopify SKU link", async () => {
    const o = fakeShopifyOrder({ id: 209, number: 2009, region: "MI", customer: SAMPLE_CUSTOMERS.pat, items: [{ sku: "LM-XL-WEB", qty: 1, price: 399.99 }] });
    await ingestOrder(db, o);
    const saved = await orderFor(o);
    expect((await items(saved.id))[0].state).toBe("needs_mapping");
    expect(await mapSku(db, ME, { source: "shopify", sku: "LM-XL-WEB", productId: lakeMat, qtyPerUnit: 1 })).toBe(1);
    expect((await items(saved.id))[0].state).toBe("recorded");
  });

  it("getOrder shows the customer and how many orders they've placed", async () => {
    const saved = await orderFor(fakeShopifyOrder({ id: 201, number: 2001, region: "MI", customer: SAMPLE_CUSTOMERS.pat, items: xl }));
    const full = await getOrder(db, saved.id);
    expect(full!.customer).toMatchObject({ name: "Pat Walsh", email: "pat.walsh@example.com", orderCount: 5 });
    expect((await listOrders(db, { customerId: full!.customer!.id })).orders).toHaveLength(5);
  });

  describe("manual pull and webhook fetch", () => {
    let dir: string;
    let source: FakeShopifySource;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "shopify-"));
      source = new FakeShopifySource(dir, 2);
      const orders = [
        fakeShopifyOrder({ id: 301, number: 3001, region: "MI", customer: SAMPLE_CUSTOMERS.pat, createdAt: "2026-11-02T10:00:00Z", items: xl }),
        fakeShopifyOrder({ id: 302, number: 3002, region: "BC", customer: SAMPLE_CUSTOMERS.renee, createdAt: "2026-11-02T11:00:00Z", items: xl }),
        fakeShopifyOrder({ id: 303, number: 3003, region: "OH", customer: SAMPLE_CUSTOMERS.sam, createdAt: "2026-11-02T12:00:00Z", status: "PENDING", items: xl }),
      ];
      for (const o of orders) await writeFile(path.join(dir, `${o.id.split("/").pop()}.json`), JSON.stringify(o));
    });

    it("fetches the order a webhook names", async () => {
      expect(await ingestOrderById(db, source, "gid://shopify/Order/301")).toBe("saved");
      expect(await ingestOrderById(db, source, "gid://shopify/Order/999")).toBe("skipped");
      expect((await syncState(db, "shopify"))!.ordersSeen).toBe(1);
    });

    it("pages through orders since a date, skipping unpaid ones and repeats", async () => {
      const since = await pullBegin(db, "2026-11-01");
      expect(since).toBe("2026-11-01T00:00:00.000Z");
      const p1 = await pullPage(db, source, since, null);
      expect(p1).toMatchObject({ count: 2, saved: 1, nextCursor: "2" }); // 301 already saved
      const p2 = await pullPage(db, source, since, p1.nextCursor);
      expect(p2).toMatchObject({ count: 1, saved: 0, nextCursor: null }); // 303 unpaid
      await pullEnd(db, p2.maxUpdated, 1);
      const state = await syncState(db, "shopify");
      expect(state!.cursor!.toISOString()).toBe("2026-11-02T12:00:00.000Z");
      expect(state!.lastError).toBeNull();
      // With no date, the next pull starts just before the last one.
      expect(await pullBegin(db, null)).toBe("2026-11-02T11:55:00.000Z");
    });
  });
});

describe("POST /api/webhooks/shopify", () => {
  const notified: [string, string][] = [];
  let app: ReturnType<typeof createApp>;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.SHOPIFY_MODE = "fake";
    process.env.SHOPIFY_SHOP = "lakemat-2.myshopify.com";
    process.env.SHOPIFY_CLIENT_SECRET = "webhook-secret";
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    const db = pg as unknown as DB;
    app = createApp({
      getDb: () => db,
      authenticate: async () => null,
      notifyMailbox: async () => {},
      verifyPushToken: async () => false,
      documentUrl: async (k) => k,
      startAmazonSync: async () => "started",
      notifyShopifyOrder: async (gid, webhookId) => {
        notified.push([gid, webhookId]);
      },
      startShopifyPull: async () => "started",
    });
  });
  afterAll(() => {
    process.env = saved;
  });

  const post = (body: string, headers: Record<string, string>) =>
    app.request("/api/webhooks/shopify", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  const body = JSON.stringify({ id: 42, admin_graphql_api_id: "gid://shopify/Order/42" });
  const good = {
    "x-shopify-topic": "orders/paid",
    "x-shopify-shop-domain": "lakemat-2.myshopify.com",
    "x-shopify-webhook-id": "wh-1",
    "x-shopify-hmac-sha256": signShopifyBody(body, "webhook-secret"),
  };

  it("starts a workflow for a signed order webhook", async () => {
    expect((await post(body, good)).status).toBe(200);
    expect(notified).toEqual([["gid://shopify/Order/42", "wh-1"]]);
  });

  it("rejects a bad signature or another shop", async () => {
    expect((await post(body, { ...good, "x-shopify-hmac-sha256": signShopifyBody(body, "wrong") })).status).toBe(401);
    expect((await post(`${body} `, good)).status).toBe(401);
    expect((await post(body, { ...good, "x-shopify-shop-domain": "someone-else.myshopify.com" })).status).toBe(401);
    expect(notified).toHaveLength(1);
  });

  it("ignores topics it doesn't handle", async () => {
    expect((await post(body, { ...good, "x-shopify-topic": "products/update" })).status).toBe(200);
    expect(notified).toHaveLength(1);
  });

  it("is refused while Shopify is off", async () => {
    process.env.SHOPIFY_MODE = "off";
    expect((await post(body, good)).status).toBe(404);
    process.env.SHOPIFY_MODE = "fake";
  });
});
