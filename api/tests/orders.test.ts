// Amazon orders: reading SP-API JSON, the API client, and orders becoming sales.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import { fakeOrder, SAMPLE_SKUS } from "../src/amazon/fake-orders";
import { normalizeAmazonOrder } from "../src/amazon/normalize";
import { FakeOrderSource, type FakeOrderFile } from "../src/amazon/order-source";
import { SpApi, SpApiError } from "../src/amazon/sp-api";
import { syncBegin, syncEnd, syncPage } from "../src/amazon/sync";
import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { applyOrder, getOrder, listOrders, mapSku, orderProblems, saveOrder, syncState } from "../src/domain/orders";
import * as svc from "../src/domain/services";
import { adjustSteel, createSteelItem, setProductSteel, steelSummary } from "../src/domain/steel";

const ME = "eric@lakemat.com";

describe("normalizeAmazonOrder", () => {
  it("keeps the marketplace, money and everything Amazon sent", () => {
    const f = fakeOrder({ id: "702-1111111-2222222", market: "CA", items: [{ sku: "LM-XL", qty: 2, price: 549.99 }] });
    const { order, items } = normalizeAmazonOrder(f.order, f.items);
    expect(order).toMatchObject({
      source: "amazon",
      externalId: "702-1111111-2222222",
      marketplaceId: "A2EUQ1WTGCTBG2",
      marketplace: "CA",
      salesChannel: "Amazon.ca",
      status: "Unshipped",
      fulfillmentChannel: "MFN",
      currency: "CAD",
      orderTotal: 1099.98,
      shipCity: "KELOWNA",
      shipCountry: "CA",
      isReplacement: false,
    });
    expect(order.raw).toBe(f.order);
    expect(items[0]).toMatchObject({ sku: "LM-XL", qtyOrdered: 2, qtyShipped: 0, itemPrice: 1099.98, itemTax: 66 });
  });

  it("copes with missing optional fields", () => {
    const { order, items } = normalizeAmazonOrder(
      { AmazonOrderId: "1", PurchaseDate: "2026-11-01T10:00:00Z", LastUpdateDate: "2026-11-01T10:00:00Z", OrderStatus: "Pending" },
      [{ OrderItemId: "a", QuantityOrdered: 1 }],
    );
    expect(order).toMatchObject({ marketplace: null, currency: null, orderTotal: null, shipCity: null });
    expect(items[0]).toMatchObject({ sku: null, itemPrice: null, qtyShipped: 0 });
  });
});

describe("SpApi", () => {
  function fakeFetch(responses: ((url: string) => { status: number; body: unknown })[]) {
    const calls: string[] = [];
    const fn = (async (url: string | URL) => {
      calls.push(String(url));
      const next = responses.shift();
      if (!next) throw new Error(`unexpected call ${url}`);
      const r = next(String(url));
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as typeof fetch;
    return { fn, calls };
  }
  const token = () => ({ status: 200, body: { access_token: "at-1", expires_in: 3600 } });
  const opts = { clientId: "id", clientSecret: "secret", refreshToken: "rt" };

  it("logs in once, then pages through orders on the live host", async () => {
    const { fn, calls } = fakeFetch([
      token,
      () => ({ status: 200, body: { payload: { Orders: [{ AmazonOrderId: "A" }], NextToken: "page2" } } }),
      () => ({ status: 200, body: { payload: { Orders: [{ AmazonOrderId: "B" }] } } }),
    ]);
    const api = new SpApi({ ...opts, mode: "live", fetch: fn });
    const p1 = await api.getOrders({ marketplaceIds: ["ATVPDKIKX0DER", "A2EUQ1WTGCTBG2"], lastUpdatedAfter: "2026-11-01T00:00:00Z" });
    expect(p1).toMatchObject({ orders: [{ AmazonOrderId: "A" }], nextToken: "page2" });
    const p2 = await api.getOrders({ marketplaceIds: ["ATVPDKIKX0DER"], lastUpdatedAfter: "x", nextToken: p1.nextToken });
    expect(p2.nextToken).toBeNull();
    expect(calls[0]).toBe("https://api.amazon.com/auth/o2/token");
    expect(calls[1]).toMatch(/^https:\/\/sellingpartnerapi-na\.amazon\.com\/orders\/v0\/orders\?/);
    expect(new URL(calls[1]).searchParams.get("MarketplaceIds")).toBe("ATVPDKIKX0DER,A2EUQ1WTGCTBG2");
    expect(new URL(calls[1]).searchParams.get("LastUpdatedAfter")).toBe("2026-11-01T00:00:00Z");
    expect(new URL(calls[2]).searchParams.get("NextToken")).toBe("page2");
    expect(calls).toHaveLength(3); // token reused
  });

  it("asks the sandbox for its canned test order", async () => {
    const { fn, calls } = fakeFetch([token, () => ({ status: 200, body: { payload: { Orders: [] } } })]);
    await new SpApi({ ...opts, mode: "sandbox", fetch: fn }).getOrders({ marketplaceIds: ["ATVPDKIKX0DER"], lastUpdatedAfter: "x" });
    expect(calls[1]).toMatch(/^https:\/\/sandbox\.sellingpartnerapi-na\.amazon\.com/);
    expect(new URL(calls[1]).searchParams.get("CreatedAfter")).toBe("TEST_CASE_200");
  });

  it("follows item pages", async () => {
    const { fn } = fakeFetch([
      token,
      () => ({ status: 200, body: { payload: { OrderItems: [{ OrderItemId: "1" }], NextToken: "t" } } }),
      (url) => {
        expect(new URL(url).searchParams.get("NextToken")).toBe("t");
        return { status: 200, body: { payload: { OrderItems: [{ OrderItemId: "2" }] } } };
      },
    ]);
    const items = await new SpApi({ ...opts, mode: "live", fetch: fn }).getOrderItems("111-1-1");
    expect(items.map((i) => i.OrderItemId)).toEqual(["1", "2"]);
  });

  it("marks throttling as retryable and bad keys as not", async () => {
    const throttled = fakeFetch([token, () => ({ status: 429, body: { errors: [{ code: "QuotaExceeded", message: "slow down" }] } })]);
    const e1 = await new SpApi({ ...opts, mode: "live", fetch: throttled.fn }).getOrderItems("x").catch((e) => e);
    expect(e1).toBeInstanceOf(SpApiError);
    expect(e1).toMatchObject({ status: 429, retryable: true });

    const badLogin = fakeFetch([() => ({ status: 400, body: { error: "invalid_grant", error_description: "bad refresh token" } })]);
    const e2 = await new SpApi({ ...opts, mode: "live", fetch: badLogin.fn }).getOrderItems("x").catch((e) => e);
    expect(e2).toMatchObject({ retryable: false, message: expect.stringMatching(/bad refresh token.*AMAZON_REFRESH_TOKEN/) });
  });
});

describe("orders become sales", () => {
  let db: DB;
  let gridSize: string;
  let pole: string;
  let lakeMat: string;
  let bare: string;

  const save = async (f: FakeOrderFile) => {
    const { id } = await saveOrder(db, normalizeAmazonOrder(f.order, f.items));
    await applyOrder(db, id);
    return id;
  };
  const items = (orderId: string) => db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId));
  const liveSales = async () => (await db.select().from(schema.sales)).filter((s) => !s.voidedAt);
  const poles = async () => (await steelSummary(db)).find((s) => s.id === pole)!.onHand;

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
    [{ id: bare }] = await db.insert(schema.products).values({ name: "DockMat Regular", productLine: "DockMat" }).returning();

    await mapSku(db, ME, { source: "amazon", sku: SAMPLE_SKUS.lakeMatXL, productId: lakeMat, qtyPerUnit: 1 });
    await mapSku(db, ME, { source: "amazon", sku: SAMPLE_SKUS.lakeMatXL2Pack, productId: lakeMat, qtyPerUnit: 2 });
  });

  it("a paid order records one sale per line and takes steel and fabric, once", async () => {
    const f = fakeOrder({ id: "111-0000001-0000001", market: "US", items: [{ sku: SAMPLE_SKUS.lakeMatXL, qty: 1, price: 399.99 }] });
    const id = await save(f);
    const [item] = await items(id);
    expect(item).toMatchObject({ state: "recorded", productId: lakeMat, problem: null });
    const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, item.saleId!));
    expect(sale).toMatchObject({ source: "amazon", externalRef: `amazon:111-0000001-0000001:${item.externalItemId}`, qty: 1, steelCost: 40 });
    expect(await poles()).toBe(96);
    expect(await svc.onHand(db, gridSize)).toBe(9);

    // Synced again (same or newer copy): nothing new.
    await save(f);
    await save({ ...f, order: { ...f.order, LastUpdateDate: new Date(Date.now() + 1000).toISOString(), OrderStatus: "Shipped" } });
    expect(await liveSales()).toHaveLength(1);
    expect(await poles()).toBe(96);
  });

  it("a pending order waits, then records when paid", async () => {
    const f = fakeOrder({ id: "111-0000002-0000002", market: "US", status: "Pending", purchasedAt: "2026-11-02T12:00:00Z", items: [{ sku: SAMPLE_SKUS.lakeMatXL, qty: 1, price: 399.99 }] });
    const id = await save(f);
    expect((await items(id))[0].state).toBe("waiting");
    expect(await poles()).toBe(96);

    await save({ ...f, order: { ...f.order, OrderStatus: "Unshipped", LastUpdateDate: "2026-11-02T13:00:00Z" } });
    expect((await items(id))[0].state).toBe("recorded");
    expect(await poles()).toBe(92);
  });

  it("an older copy never overwrites a newer one", async () => {
    const f = fakeOrder({ id: "111-0000002-0000002", market: "US", status: "Pending", purchasedAt: "2026-11-02T12:00:00Z", items: [{ sku: SAMPLE_SKUS.lakeMatXL, qty: 1, price: 399.99 }] });
    expect((await saveOrder(db, normalizeAmazonOrder(f.order, f.items))).changed).toBe(false);
    expect((await getOrder(db, (await listOrders(db, { q: "0000002" })).orders[0].id))!.status).toBe("Unshipped");
  });

  it("a cancel undoes the sale and puts stock back", async () => {
    const f = fakeOrder({ id: "111-0000003-0000003", market: "US", purchasedAt: "2026-11-03T12:00:00Z", items: [{ sku: SAMPLE_SKUS.lakeMatXL, qty: 1, price: 399.99 }] });
    const id = await save(f);
    expect(await poles()).toBe(88);
    await save({ ...f, order: { ...f.order, OrderStatus: "Canceled", LastUpdateDate: "2026-11-03T14:00:00Z" } });
    const [item] = await items(id);
    expect(item.state).toBe("canceled");
    const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, item.saleId!));
    expect(sale.voidedAt).not.toBeNull();
    expect(await poles()).toBe(92);
    await applyOrder(db, id); // again: no error, no change
    expect(await poles()).toBe(92);
  });

  it("an unknown SKU waits for a link; linking it records the sale", async () => {
    const f = fakeOrder({ id: "111-0000004-0000004", market: "US", items: [{ sku: "LM-XL-NEW", qty: 1, price: 399.99 }] });
    const id = await save(f);
    expect((await items(id))[0]).toMatchObject({ state: "needs_mapping", problem: "SKU LM-XL-NEW isn't linked to a product." });
    expect((await orderProblems(db)).unmapped).toEqual([{ source: "amazon", sku: "LM-XL-NEW", title: expect.any(String), orders: 1 }]);
    expect((await listOrders(db, { problemsOnly: true })).orders.map((o) => o.externalId)).toEqual(["111-0000004-0000004"]);

    expect(await mapSku(db, ME, { source: "amazon", sku: "LM-XL-NEW", productId: lakeMat, qtyPerUnit: 1 })).toBe(1);
    expect((await items(id))[0].state).toBe("recorded");
    expect((await orderProblems(db)).unmapped).toEqual([]);
  });

  it("a SKU marked not a factory product is ignored", async () => {
    await mapSku(db, ME, { source: "amazon", sku: "GIFT-CARD", productId: null, qtyPerUnit: 1 });
    const id = await save(fakeOrder({ market: "US", items: [{ sku: "GIFT-CARD", qty: 1, price: 25 }] }));
    expect((await items(id))[0].state).toBe("ignored");
  });

  it("a product without a recipe waits, and records once it has one", async () => {
    await mapSku(db, ME, { source: "amazon", sku: SAMPLE_SKUS.dockMat, productId: bare, qtyPerUnit: 1 });
    const id = await save(fakeOrder({ market: "US", items: [{ sku: SAMPLE_SKUS.dockMat, qty: 1, price: 199 }] }));
    expect((await items(id))[0]).toMatchObject({ state: "needs_recipe", problem: expect.stringMatching(/no recipe/) });
    expect((await orderProblems(db)).noRecipe).toEqual([{ productId: bare, productName: "DockMat Regular", lines: 1 }]);

    await setProductSteel(db, { productId: bare, steelItemId: pole, qty: 2 });
    await syncEnd(db, null, 0); // every sync retries waiting lines
    expect((await items(id))[0].state).toBe("recorded");
  });

  it("a 2-pack takes two products' worth", async () => {
    const before = await poles();
    const id = await save(fakeOrder({ market: "US", items: [{ sku: SAMPLE_SKUS.lakeMatXL2Pack, qty: 1, price: 749.99 }] }));
    const [item] = await items(id);
    const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, item.saleId!));
    expect(sale.qty).toBe(2);
    expect(await poles()).toBe(before - 8);
  });

  it("Canada orders keep CAD and filter by marketplace", async () => {
    await save(fakeOrder({ id: "702-0000005-0000005", market: "CA", items: [{ sku: SAMPLE_SKUS.lakeMatXL, qty: 1, price: 549.99 }] }));
    const ca = await listOrders(db, { marketplace: "CA" });
    expect(ca.orders).toHaveLength(1);
    expect(ca.orders[0]).toMatchObject({ currency: "CAD", orderTotal: 549.99, marketplace: "CA" });
    expect(ca.orders[0].items[0]).toMatchObject({ state: "recorded", productName: "LakeMat XL", steelCost: 40 });
    expect(ca.orders[0]).not.toHaveProperty("raw");
  });

  it("sync reads pages from the source, skips unchanged orders and moves the cursor", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fake-amazon-"));
    const source = new FakeOrderSource(dir, 2);
    let itemCalls = 0;
    const counting = { ...source, itemDelayMs: 0, listOrders: source.listOrders.bind(source), getOrderItems: (id: string) => (itemCalls++, source.getOrderItems(id)) };
    for (const n of [1, 2, 3]) {
      const f = fakeOrder({ id: `113-000000${n}-0000000`, market: "US", purchasedAt: `2026-10-2${n}T12:00:00Z`, items: [{ sku: SAMPLE_SKUS.lakeMatXL, qty: 1, price: 399.99 }] });
      await writeFile(path.join(dir, `${f.order.AmazonOrderId}.json`), JSON.stringify(f));
    }

    const run = async () => {
      const since = await syncBegin(db, new Date("2026-11-05T00:00:00Z"));
      let token: string | null = null;
      let max: string | null = null;
      let count = 0;
      do {
        const r = await syncPage(db, counting, since, token);
        token = r.nextToken;
        count += r.count;
        if (r.maxUpdated && (!max || r.maxUpdated > max)) max = r.maxUpdated;
      } while (token);
      await syncEnd(db, max, count);
      return count;
    };

    expect(await run()).toBe(3); // first run: 30 days back, two pages
    expect(itemCalls).toBe(3);
    expect((await syncState(db, "amazon"))!.cursor!.toISOString()).toBe("2026-10-23T12:00:00.000Z");
    expect(await run()).toBe(1); // overlap re-reads the newest; unchanged, so no item call
    expect(itemCalls).toBe(3);
    expect((await listOrders(db, { q: "113-000000" })).orders).toHaveLength(3);
  });
});
