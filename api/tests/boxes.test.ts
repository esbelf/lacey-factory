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
import { recordDocument, saveExtraction, saveSupplier } from "../src/domain/invoices";
import { applyOrder, mapSku, saveOrder } from "../src/domain/orders";
import { listProducts } from "../src/domain/queries";
import { recordSale, voidSale } from "../src/domain/sales";
import * as svc from "../src/domain/services";
import {
  addSupplierSteelProduct,
  adjustSteel,
  autoReceiveSteel,
  createSteelItem,
  receiveSteel,
  setProductBox,
  setProductSteel,
  steelSummary,
} from "../src/domain/steel";
import type { DocumentExtraction } from "../src/temporal/extract";

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

  describe("box manufacturer invoices", () => {
    let supplierId: string;
    let n = 0;
    const line = (code: string, quantity: number, unit_price: number) => ({
      line_kind: "product" as const,
      product_code: code,
      description: `RSC BOX ${code}`,
      quantity,
      uom: "EA",
      unit_price,
      amount: quantity * unit_price,
      width_ft: null,
      length_ft: null,
      roll_numbers: [],
    });
    const invoice = (number: string, total: number): DocumentExtraction => ({
      is_invoice_or_packing_list: true,
      document_type: "invoice",
      invoice_number: number,
      invoice_date: "2026-10-20",
      ship_date: null,
      invoice_total: total,
      lines: [
        line("RSC-581408", 100, 3.5),
        line("RSC-592310", 50, 6),
        { ...line("FRT", 1, 50), line_kind: "freight" as const, product_code: null, description: "FREIGHT" },
      ],
    });
    async function newDoc(x: DocumentExtraction) {
      n++;
      const doc = await recordDocument(db, {
        supplierId,
        account: ME,
        gmailMessageId: `box-${n}`,
        sha256: `box-sha-${n}`,
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        emailFrom: "Box Co <ar@boxco.com>",
        emailSubject: "Invoice",
        emailReceivedAt: new Date("2026-10-20T15:00:00Z"),
        s3Key: `suppliers/boxes/${n}.pdf`,
      });
      await saveExtraction(db, doc.id, x);
      return doc.id;
    }

    beforeAll(async () => {
      supplierId = await saveSupplier(db, { name: "Box Co", emailPatterns: "@boxco.com", kind: "boxes" });
      await addSupplierSteelProduct(db, { supplierId, productCode: "RSC-581408", steelItemId: box });
      await addSupplierSteelProduct(db, { supplierId, productCode: "RSC-592310", steelItemId: bigBox });
    });

    it("only maps a box supplier's codes to boxes", async () => {
      await expect(addSupplierSteelProduct(db, { supplierId, productCode: "POLE", steelItemId: pole })).rejects.toThrow(/pick a box/);
    });

    it("adds an invoiced delivery to box stock with freight spread in", async () => {
      const lakemat = await onHand(box);
      const muckmat = await onHand(bigBox);
      const id = await newDoc(invoice("B-100", 700));
      expect(await autoReceiveSteel(db, id)).toMatchObject({ status: "registered", stockKind: "box" });
      expect(await onHand(box)).toBe(lakemat + 100);
      expect(await onHand(bigBox)).toBe(muckmat + 50);
      const lots = await db.select().from(schema.steelLots).where(eq(schema.steelLots.sourceDocumentId, id));
      // $50 freight over $350 + $300 of boxes, by value.
      expect(lots.find((l) => l.steelItemId === box)).toMatchObject({ qty: 100, unitCost: 3.5, landedUnitCost: 3.7692 });
    });

    it("sends an unknown box to review, worded for boxes", async () => {
      const x = invoice("B-101", 700);
      x.lines[0] = line("RSC-999", 100, 3.5);
      expect(await autoReceiveSteel(db, await newDoc(x))).toMatchObject({
        status: "needs_review",
        reason: expect.stringMatching(/Unknown box "RSC-999/),
      });
    });

    it("refuses a pole on a box invoice when reviewed by hand", async () => {
      const id = await newDoc({ ...invoice("B-102", 700), invoice_total: 1 });
      await expect(
        receiveSteel(db, id, { freight: 0, lines: [{ steelItemId: pole, label: "", qty: 1, unitCost: 1, amount: 1 }] }, { actor: ME }),
      ).rejects.toThrow(/pick a box/);
    });
  });
});
