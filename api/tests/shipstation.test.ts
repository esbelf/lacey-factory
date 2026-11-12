// ShipStation labels: matching to orders, cost per order, voids, re-checks and signed webhooks.
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { getOrder, listOrders, saveOrder, syncState } from "../src/domain/orders";
import { matchKeys } from "../src/domain/shipments";
import { ShipStationApi, ShipStationError } from "../src/shipstation/api";
import { fakeLabel, type FakeLabelInput } from "../src/shipstation/fake-labels";
import { FakeShipStationSource, type FakeLabelFile } from "../src/shipstation/source";
import { ingestEvent, pullBegin, pullEnd, pullPage } from "../src/shipstation/sync";
import { clearSigningKeys, SIGNATURE_HEADERS, verifyShipStationSignature } from "../src/shipstation/webhook";

const order = (source: "amazon" | "shopify", externalId: string, orderName: string | null = null, currency = "USD") => ({
  order: {
    source,
    externalId,
    orderName,
    status: source === "amazon" ? "Shipped" : "PAID",
    currency,
    subtotal: 400,
    orderTotal: 425,
    purchasedAt: new Date("2026-11-01T12:00:00Z"),
    lastUpdatedAt: new Date("2026-11-01T12:00:00Z"),
    raw: {},
  },
  items: [],
});

describe("matchKeys", () => {
  it("uses the Amazon order number for Amazon stores", () => {
    expect(matchKeys("amazon_us", "112-1234567-1234567", null)).toEqual({
      source: "amazon",
      externalIds: ["112-1234567-1234567"],
      orderNames: [],
    });
  });

  it("turns Shopify's numeric id into our gid and tries the order number with and without #", () => {
    expect(matchKeys("shopify", "5550001", "1001")).toEqual({
      source: "shopify",
      externalIds: ["gid://shopify/Order/5550001"],
      orderNames: ["1001", "#1001", "5550001", "#5550001"],
    });
  });
});

describe("ShipStation labels", () => {
  let db: DB;
  let dir: string;
  let source: FakeShipStationSource;
  const write = async (f: FakeLabelFile) => {
    await writeFile(path.join(dir, `${f.label.label_id}.json`), JSON.stringify(f));
    return f;
  };
  const label = (i: FakeLabelInput) => write(fakeLabel(i));
  const event = (labelId: string, ev = "label_created_v2") =>
    ingestEvent(db, source, { resource_type: ev.toUpperCase(), data: { label_id: labelId } }, new Date("2026-11-03T15:00:00Z"));

  beforeEach(async () => {
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    db = pg as unknown as DB;
    dir = await mkdtemp(path.join(tmpdir(), "ss-"));
    source = new FakeShipStationSource(dir);
  });

  it("links an Amazon label by order number and shows its cost on the order", async () => {
    const { id } = await saveOrder(db, order("amazon", "112-1111111-1111111"));
    const f = await label({ orderSourceCode: "amazon_us", externalOrderId: "112-1111111-1111111", cost: 21.5, insurance: 2 });
    expect(await event(f.label.label_id)).toMatchObject({ labels: 1, matched: 1 });
    const o = await getOrder(db, id);
    expect(o).toMatchObject({ shippingCost: 23.5, shippingCurrency: "USD", shippedOn: f.label.created_at!.slice(0, 10) });
    expect(o!.shipments).toHaveLength(1);
    expect(o!.shipments[0]).toMatchObject({ carrierCode: "ups", counts: true });
  });

  it("links a Shopify label by numeric id, or by #number when the id doesn't match", async () => {
    const a = await saveOrder(db, order("shopify", "gid://shopify/Order/700", "#1001"));
    const b = await saveOrder(db, order("shopify", "gid://shopify/Order/701", "#1002"));
    const byId = await label({ orderSourceCode: "shopify", externalOrderId: "700", shipmentNumber: "1001" });
    const byName = await label({ orderSourceCode: "shopify", externalOrderId: "something-else", shipmentNumber: "1002" });
    await event(byId.label.label_id);
    await event(byName.label.label_id);
    expect((await getOrder(db, a.id))!.shipments).toHaveLength(1);
    expect((await getOrder(db, b.id))!.shipments).toHaveLength(1);
  });

  it("adds up split shipments, and a re-sent event changes nothing", async () => {
    const { id } = await saveOrder(db, order("amazon", "112-2222222-2222222"));
    const one = await label({ orderSourceCode: "amazon_us", externalOrderId: "112-2222222-2222222", cost: 10 });
    const two = await label({ orderSourceCode: "amazon_us", externalOrderId: "112-2222222-2222222", cost: 12.25 });
    await event(one.label.label_id);
    await event(two.label.label_id);
    await event(two.label.label_id);
    expect(await getOrder(db, id)).toMatchObject({ shippingCost: 22.25 });
    expect(await db.select().from(schema.shipments)).toHaveLength(2);
    const [listed] = (await listOrders(db)).orders;
    expect(listed).toMatchObject({ shippingCost: 22.25 });
  });

  it("a label that arrives before its order is linked when the order is saved", async () => {
    const f = await label({ orderSourceCode: "shopify", externalOrderId: "900", shipmentNumber: "1009", cost: 15 });
    expect(await event(f.label.label_id)).toMatchObject({ matched: 0 });
    const { id } = await saveOrder(db, order("shopify", "gid://shopify/Order/900", "#1009"));
    expect(await getOrder(db, id)).toMatchObject({ shippingCost: 15 });
  });

  it("marks the shipment shipped on fulfillment_shipped_v2", async () => {
    await saveOrder(db, order("amazon", "112-3333333-3333333"));
    const f = await label({ orderSourceCode: "amazon_us", externalOrderId: "112-3333333-3333333" });
    await event(f.label.label_id);
    await ingestEvent(db, source, { resource_type: "FULFILLMENT_SHIPPED_V2", data: { shipment_id: f.shipment.shipment_id } }, new Date("2026-11-04T10:00:00Z"));
    const [s] = await db.select().from(schema.shipments);
    expect(s.shippedAt?.toISOString()).toBe("2026-11-04T10:00:00.000Z");
  });

  it("follows resource_url on ShipStation's host only", async () => {
    const { id } = await saveOrder(db, order("amazon", "112-4444444-4444444"));
    const f = await label({ orderSourceCode: "amazon_us", externalOrderId: "112-4444444-4444444", cost: 9 });
    await ingestEvent(db, source, { resource_url: `https://api.shipstation.com/v2/labels/${f.label.label_id}` });
    expect(await getOrder(db, id)).toMatchObject({ shippingCost: 9 });

    const api = new ShipStationApi("key", { fetch: async () => new Response("{}") });
    await expect(api.request("https://evil.example.com/v2/labels/1")).rejects.toThrow(ShipStationError);
  });

  it("re-check imports labels, drops voided ones from the cost, and moves the cursor", async () => {
    const { id } = await saveOrder(db, order("amazon", "112-5555555-5555555"));
    const keep = await label({ orderSourceCode: "amazon_us", externalOrderId: "112-5555555-5555555", cost: 30, createdAt: "2026-11-02T10:00:00Z" });
    const gone = await label({ orderSourceCode: "amazon_us", externalOrderId: "112-5555555-5555555", cost: 30, createdAt: "2026-11-02T11:00:00Z" });
    const since = await pullBegin(db, "2026-11-01");
    const r = await pullPage(db, source, since, 1);
    expect(r).toMatchObject({ count: 2, pages: 1, maxCreated: "2026-11-02T11:00:00Z" });
    await pullEnd(db, source, r.maxCreated, r.count, new Date("2026-11-05T00:00:00Z"));
    expect(await getOrder(db, id)).toMatchObject({ shippingCost: 60 });

    await write({ ...gone, label: { ...gone.label, status: "voided", voided: true, voided_at: "2026-11-03T00:00:00Z" } });
    await pullEnd(db, source, null, 0, new Date("2026-11-05T00:00:00Z"));
    const o = await getOrder(db, id);
    expect(o).toMatchObject({ shippingCost: 30 });
    expect(o!.shipments.find((s) => s.labelId === gone.label.label_id)).toMatchObject({ status: "voided", counts: false });
    expect(o!.shipments.find((s) => s.labelId === keep.label.label_id)).toMatchObject({ counts: true });
    expect((await syncState(db, "shipstation"))?.cursor?.toISOString()).toBe("2026-11-02T11:00:00.000Z");
  });

  it("an order with no labels has no shipping cost", async () => {
    const { id } = await saveOrder(db, order("amazon", "112-6666666-6666666"));
    expect(await getOrder(db, id)).toMatchObject({ shippingCost: null, shippedOn: null, shipments: [] });
    expect((await db.select().from(schema.orders).where(eq(schema.orders.id, id))).length).toBe(1);
  });
});

describe("ShipStation webhook signatures", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1" };
  const jwksFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch;
  const NOW = Date.parse("2026-11-11T12:00:00Z");
  const ts = new Date(NOW).toISOString();
  const sign = (t: string, body: string) => createSign("RSA-SHA256").update(`${t}.${body}`).sign(privateKey, "base64");
  const body = JSON.stringify({ resource_type: "LABEL_CREATED_V2", data: { label_id: "se-1" } });
  const headers = (over: Record<string, string> = {}) => ({
    "content-type": "application/json",
    [SIGNATURE_HEADERS.keyId]: "key-1",
    [SIGNATURE_HEADERS.timestamp]: ts,
    [SIGNATURE_HEADERS.signature]: sign(ts, body),
    ...over,
  });

  const notified: unknown[] = [];
  let app: ReturnType<typeof createApp>;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.SHIPSTATION_MODE = "live";
    clearSigningKeys();
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
      notifyShopifyOrder: async () => {},
      startShopifyPull: async () => "started",
      notifyShipStation: async (b) => {
        notified.push(b);
      },
      startShipStationPull: async () => "started",
      verifyShipStation: (raw, header) => verifyShipStationSignature(raw, header, { jwksUrl: "https://jwks.test/jwks", fetch: jwksFetch, now: NOW }),
    });
  });
  afterAll(() => {
    process.env = saved;
  });

  const post = (b: string, h: Record<string, string>) => app.request("/api/webhooks/shipstation", { method: "POST", body: b, headers: h });

  it("accepts a signed delivery and starts a workflow", async () => {
    expect((await post(body, headers())).status).toBe(200);
    expect(notified).toEqual([JSON.parse(body)]);
  });

  it("refuses a tampered body, a stale timestamp, an unknown key or missing headers", async () => {
    expect((await post(`${body} `, headers())).status).toBe(401);
    const old = new Date(NOW - 10 * 60_000).toISOString();
    expect((await post(body, headers({ [SIGNATURE_HEADERS.timestamp]: old, [SIGNATURE_HEADERS.signature]: sign(old, body) }))).status).toBe(400);
    expect((await post(body, headers({ [SIGNATURE_HEADERS.keyId]: "nope" }))).status).toBe(401);
    expect((await post(body, { "content-type": "application/json" })).status).toBe(401);
    expect(notified).toHaveLength(1);
  });
});
