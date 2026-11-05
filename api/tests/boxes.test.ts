// Shipping boxes: stocked at FIFO cost like steel and taken one per product sold.
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import { fakeOrder } from "../src/amazon/fake-orders";
import { normalizeAmazonOrder } from "../src/amazon/normalize";
import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { applyOrder, mapSku, saveOrder } from "../src/domain/orders";
import { listProducts } from "../src/domain/queries";
import { recordSale, voidSale } from "../src/domain/sales";
import * as svc from "../src/domain/services";
import { adjustSteel, createSteelItem, setProductBox, setProductSteel, steelSummary } from "../src/domain/steel";

const ME = "eric@lakemat.com";

describe("shipping boxes", () => {
  let db: DB;
  let pole: string;
  let box: string;
  let bigBox: string;
  let mat: string;

  const onHand = async (id: string) => (await steelSummary(db)).find((s) => s.id === id)!.onHand;

  beforeAll(async () => {
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    db = pg as unknown as DB;

    const grid = await svc.createMaterial(db, { name: "Geogrid", requiresSewing: false });
    const size = (await svc.createCutSize(db, { materialId: grid.id, label: "12x24", widthFt: 12, cutLengthFt: 24 })).id;
    const roll = await svc.createRoll(db, ME, { materialId: grid.id, widthFt: 12, lengthFt: 300, receivedOn: "2026-09-01" });
    await svc.recordCut(db, ME, { rollId: roll.id, cutOn: "2026-09-02", lines: [{ cutSizeId: size, qty: 10 }] });

    pole = (await createSteelItem(db, { name: "Long" })).id;
    box = (await createSteelItem(db, { name: "LAKEMAT BOX", kind: "box", lengthIn: 58, widthIn: 14, heightIn: 8 })).id;
    bigBox = (await createSteelItem(db, { name: "MUCKMAT BOX", kind: "box", lengthIn: 59, widthIn: 23, heightIn: 10 })).id;
    await adjustSteel(db, ME, { steelItemId: pole, qty: 20, reason: "opening_balance", unitCost: 10, adjustedOn: "2026-09-01" });
    // Two box deliveries at different prices, for FIFO.
    await adjustSteel(db, ME, { steelItemId: box, qty: 1, reason: "opening_balance", unitCost: 4, adjustedOn: "2026-09-01" });
    await adjustSteel(db, ME, { steelItemId: box, qty: 5, reason: "count_correction", unitCost: 5, adjustedOn: "2026-09-10" });

    [{ id: mat }] = await db.insert(schema.products).values({ name: "LakeMat XL", productLine: "LakeMat" }).returning();
    await db.insert(schema.productComponents).values({ productId: mat, cutSizeId: size, qty: 1 });
    await setProductSteel(db, { productId: mat, steelItemId: pole, qty: 2 });
    await setProductBox(db, { productId: mat, boxId: box });
  });

  it("stores box sizes and lists the box apart from steel", async () => {
    const summary = await steelSummary(db);
    expect(summary.find((s) => s.id === box)).toMatchObject({ kind: "box", lengthIn: 58, widthIn: 14, heightIn: 8, onHand: 6, value: 29 });
    expect(summary.find((s) => s.id === pole)).toMatchObject({ kind: "steel", lengthIn: null });
    const [p] = await listProducts(db);
    expect(p).toMatchObject({ box: { steelItemId: box, qty: 1 }, steel: [{ steelItemId: pole, qty: 2 }] });
  });

  it("a sale takes one box per product, oldest first, and records box cost apart from steel", async () => {
    const { sale } = await recordSale(db, ME, { productId: mat, qty: 2, soldOn: "2026-10-01", source: "manual" });
    expect(sale).toMatchObject({ steelCost: 40, boxCost: 9, short: false }); // boxes at $4 then $5
    expect(await onHand(box)).toBe(4);

    await voidSale(db, ME, sale.id);
    expect(await onHand(box)).toBe(6);
  });

  it("selling with no boxes left is short until boxes arrive", async () => {
    await setProductBox(db, { productId: mat, boxId: bigBox });
    const { sale } = await recordSale(db, ME, { productId: mat, qty: 1, soldOn: "2026-10-02", source: "manual" });
    expect(sale).toMatchObject({ short: true, boxCost: 0 });
    expect(await onHand(bigBox)).toBe(-1);

    await adjustSteel(db, ME, { steelItemId: bigBox, qty: 3, reason: "count_correction", unitCost: 7, adjustedOn: "2026-10-03" });
    const [after] = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id));
    expect(after).toMatchObject({ short: false, boxCost: 7 });
    expect(await onHand(bigBox)).toBe(2);
  });

  it("a product has one box: setting another replaces it", async () => {
    await setProductBox(db, { productId: mat, boxId: box });
    const rows = await db.select().from(schema.productSteel).where(eq(schema.productSteel.productId, mat));
    expect(rows.map((r) => r.steelItemId).sort()).toEqual([pole, box].sort());
    await expect(setProductBox(db, { productId: mat, boxId: pole })).rejects.toThrow("Pick a box.");
    await expect(setProductSteel(db, { productId: mat, steelItemId: bigBox, qty: 1 })).rejects.toThrow(/box picker/);
  });

  it("a product with only a box has no recipe yet, so it can't be sold", async () => {
    const [{ id }] = await db.insert(schema.products).values({ name: "SandMat 7x20", productLine: "SandMat" }).returning();
    await setProductBox(db, { productId: id, boxId: box });
    await expect(recordSale(db, ME, { productId: id, qty: 1, soldOn: "2026-10-04", source: "manual" })).rejects.toThrow(/no recipe/);
  });

  it("box counts can be corrected down", async () => {
    const before = await onHand(box);
    await adjustSteel(db, ME, { steelItemId: box, qty: -1, reason: "count_correction", adjustedOn: "2026-10-05" });
    expect(await onHand(box)).toBe(before - 1);
  });

  it("an Amazon order takes the box; a cancel puts it back", async () => {
    await mapSku(db, ME, { source: "amazon", sku: "LM-XL", productId: mat, qtyPerUnit: 1 });
    const f = fakeOrder({ id: "111-0000009-0000009", market: "US", items: [{ sku: "LM-XL", qty: 1, price: 399.99 }] });
    const before = await onHand(box);
    const { id } = await saveOrder(db, normalizeAmazonOrder(f.order, f.items));
    await applyOrder(db, id);
    const [item] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, id));
    const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, item.saleId!));
    expect(sale.boxCost).toBe(5);
    expect(await onHand(box)).toBe(before - 1);

    const canceled = { ...f.order, OrderStatus: "Canceled", LastUpdateDate: new Date(Date.now() + 1000).toISOString() };
    await saveOrder(db, normalizeAmazonOrder(canceled, f.items));
    await applyOrder(db, id);
    expect(await onHand(box)).toBe(before);
  });
});
