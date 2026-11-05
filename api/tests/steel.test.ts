// Steel: reading invoices into FIFO cost lots, and sales that use up steel and fabric.
import { PGlite } from "@electric-sql/pglite";
import { formatMoney, mulMoney, sumMoney } from "@lacey-factory/shared/money";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { recordDocument, saveExtraction, saveSupplier } from "../src/domain/invoices";
import { recordSale, voidSale } from "../src/domain/sales";
import * as svc from "../src/domain/services";
import {
  addSupplierSteelProduct,
  adjustSteel,
  allocateFreight,
  autoReceiveSteel,
  createSteelItem,
  planSteel,
  setProductSteel,
  type SteelMapping,
  steelSummary,
} from "../src/domain/steel";
import { codeMatches } from "../src/domain/invoices";
import { allBendingInvoice, steelInvoice } from "./fixtures/steel-extraction";

const ME = "eric@lakemat.com";
const mapping = (productCode: string, steelItemId: string, descriptionMatch: string | null = null): SteelMapping => ({
  id: productCode,
  supplierId: "s1",
  productCode,
  descriptionMatch,
  steelItemId,
  createdAt: new Date(),
});
const MAPPINGS = [mapping("SP-114-10", "small"), mapping("SP-158-10", "large")];

describe("money", () => {
  it("adds and multiplies without float drift", () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(mulMoney(3, 18.3333)).toBe(54.9999);
    expect(formatMoney(1234.5)).toBe("$1,234.50");
    expect(formatMoney(12.3456)).toBe("$12.3456");
  });
});

describe("planSteel", () => {
  it("maps each line to a steel item and totals the freight", () => {
    expect(planSteel(steelInvoice, MAPPINGS)).toEqual({
      ok: true,
      freight: 120,
      lines: [
        { steelItemId: "small", label: `SP-114-10 1-1/4" SCH40 GALV PIPE 10'`, qty: 40, unitCost: 18.75, amount: 750 },
        { steelItemId: "large", label: `SP-158-10 1-5/8" GALV PIPE 10'`, qty: 20, unitCost: 22.5, amount: 450 },
      ],
    });
  });

  it("adds up several freight lines, and is fine with none", () => {
    const [a, b, freight] = steelInvoice.lines;
    const two = planSteel({ ...steelInvoice, lines: [a, b, { ...freight, amount: 100 }, { ...freight, amount: 20 }] }, MAPPINGS);
    expect(two.ok && two.freight).toBe(120);
    const none = planSteel({ ...steelInvoice, invoice_total: 1200, lines: [a, b] }, MAPPINGS);
    expect(none.ok && none.freight).toBe(0);
  });

  it("works out the rate from the amount when only the amount is printed", () => {
    const [a] = steelInvoice.lines;
    const plan = planSteel({ ...steelInvoice, invoice_total: null, lines: [{ ...a, unit_price: null }] }, MAPPINGS);
    expect(plan.ok && plan.lines[0].unitCost).toBe(18.75);
  });

  it("sends anything doubtful to review", () => {
    const [a, b, freight] = steelInvoice.lines;
    const check = (lines: typeof steelInvoice.lines, total: number | null = null) =>
      planSteel({ ...steelInvoice, invoice_total: total, lines }, MAPPINGS);

    expect(check([{ ...a, product_code: "X-1", description: "MYSTERY PIPE" }])).toMatchObject({ reason: expect.stringMatching(/Unknown steel item/) });
    expect(check([{ ...a, amount: 800 }])).toMatchObject({ reason: expect.stringMatching(/40 × \$18\.75 = \$750\.00, but the line says \$800\.00/) });
    expect(check([{ ...a, uom: "LB" }])).toMatchObject({ reason: expect.stringMatching(/priced per LB/) });
    expect(check([{ ...a, quantity: 2.5 }])).toMatchObject({ reason: expect.stringMatching(/how many poles/) });
    expect(check([{ ...a, unit_price: null, amount: null }])).toMatchObject({ reason: expect.stringMatching(/no rate or amount/) });
    expect(check([a, b, { ...freight, amount: null }])).toMatchObject({ reason: expect.stringMatching(/freight line/) });
    expect(check([a, b, freight], 1500)).toMatchObject({ reason: expect.stringMatching(/add up to \$1320\.00 but the invoice total is \$1500\.00/) });
    expect(check([freight])).toMatchObject({ reason: "No steel lines found." });
    expect(planSteel({ ...steelInvoice, is_invoice_or_packing_list: false }, MAPPINGS).ok).toBe(false);
  });

  it("allows a cent per pole of rounding in the rate", () => {
    const [a] = steelInvoice.lines;
    expect(planSteel({ ...steelInvoice, invoice_total: null, lines: [{ ...a, quantity: 3, unit_price: 33.33, amount: 100 }] }, MAPPINGS).ok).toBe(true);
  });
});

describe("item codes", () => {
  it("ignores case and spacing, and matches codes the invoice cut off", () => {
    expect(codeMatches("11192 HYDRILLA SLIP", "11192-Hydrilla Slip")).toBe(true);
    expect(codeMatches("11192-HYDRILLA CO...", "11192-HYDRILLA CORNERS")).toBe(true);
    expect(codeMatches("11192-HYDRILLA CO...", "11192-HYDRILLA CO...")).toBe(true);
    expect(codeMatches("11192-HYDRILLA CORNERS", "11192-HYDRILLA CO…")).toBe(true);
    expect(codeMatches("11192-HYDRILLA CO...", "11192-HYDRILLA LONG")).toBe(false);
    expect(codeMatches("11191 H-SLIP", "11191 H-SLIPX")).toBe(false);
  });
});

describe("All Bending invoice 64538 (real sample)", () => {
  const codes = {
    "11191 H-SLIP": "slip",
    "11191 H-CORNER": "corner",
    "11191 H-LONG": "long",
    "11192-HYDRILLA CO...": "corner1",
    "11192-HYDRILLA LO...": "long1",
    "11192-HYDRILLA SLIP": "slip1",
  };
  const mappings = Object.entries(codes).map(([code, item]) => mapping(code, item));

  it("maps all six lines and checks out against the total", () => {
    const plan = planSteel(allBendingInvoice, mappings);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.freight).toBe(25);
    expect(plan.lines.map((l) => [l.steelItemId, l.qty, l.unitCost])).toEqual([
      ["slip", 25, 7.47],
      ["corner1", 479, 8.44],
      ["corner", 25, 8.44],
      ["long", 48, 9.88],
      ["long1", 752, 9.88],
      ["slip1", 297, 7.47],
    ]);
    expect(sumMoney(allocateFreight(plan.lines, plan.freight))).toBe(25);
  });

  it("goes to review if the two cut-off codes can't be told apart", () => {
    const vague = [...mappings, mapping("11192-HYDRILLA", "other")];
    // "11192-HYDRILLA" (set up) is a prefix of both, but only matches when the set-up code itself is cut off.
    expect(planSteel(allBendingInvoice, vague).ok).toBe(true);
    const cutOff = [...mappings.filter((m) => m.steelItemId !== "corner1"), mapping("11192-HYDR...", "x"), mapping("11192-HYDRILLA CORNERS", "corner1")];
    expect(planSteel(allBendingInvoice, cutOff)).toMatchObject({ ok: false, reason: expect.stringMatching(/more than one/) });
  });
});

describe("allocateFreight", () => {
  it("splits by dollar value and always adds up exactly", () => {
    expect(allocateFreight([{ amount: 750, qty: 40 }, { amount: 450, qty: 20 }], 120)).toEqual([75, 45]);
    const thirds = allocateFreight([1, 2, 3].map(() => ({ amount: 100, qty: 1 })), 100);
    expect(sumMoney(thirds)).toBe(100);
    expect(thirds.sort()).toEqual([33.3333, 33.3333, 33.3334]);
    expect(allocateFreight([{ amount: 0, qty: 1 }, { amount: 0, qty: 3 }], 40)).toEqual([10, 30]);
    expect(allocateFreight([{ amount: 10, qty: 1 }], 0)).toEqual([0]);
  });
});

describe("steel inventory and sales", () => {
  let db: DB;
  let supplierId: string;
  let small: string;
  let large: string;
  let gridSize: string;
  let productId: string;
  let firstCut: string;
  let n = 0;

  const item = async (id: string) => (await steelSummary(db)).find((s) => s.id === id)!;
  const gridOnHand = () => svc.onHand(db, gridSize);

  async function newDoc(extraction = steelInvoice) {
    n++;
    const doc = await recordDocument(db, {
      supplierId,
      account: ME,
      gmailMessageId: `steel-${n}`,
      sha256: `sha-${n}`,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      emailFrom: "Midwest Steel <billing@midweststeel.com>",
      emailSubject: "Invoice",
      emailReceivedAt: new Date("2026-10-02T15:00:00Z"),
      s3Key: `suppliers/steel/${n}.pdf`,
    });
    await saveExtraction(db, doc.id, extraction);
    return doc.id;
  }

  beforeAll(async () => {
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    db = pg as unknown as DB;

    supplierId = await saveSupplier(db, { name: "Midwest Steel", emailPatterns: "@midweststeel.com", kind: "steel" });
    small = (await createSteelItem(db, { name: `1-1/4" × 10' pole` })).id;
    large = (await createSteelItem(db, { name: `1-5/8" × 10' pole` })).id;
    await addSupplierSteelProduct(db, { supplierId, productCode: "SP-114-10", steelItemId: small });
    await addSupplierSteelProduct(db, { supplierId, descriptionMatch: "1-5/8", steelItemId: large });

    // Geogrid isn't sewn, so cut pieces go straight to stock. Two cuts on different days for FIFO.
    const grid = await svc.createMaterial(db, { name: "Geogrid", requiresSewing: false });
    gridSize = (await svc.createCutSize(db, { materialId: grid.id, label: "12x24", widthFt: 12, cutLengthFt: 24 })).id;
    const roll = await svc.createRoll(db, ME, { materialId: grid.id, widthFt: 12, lengthFt: 300, receivedOn: "2026-09-01" });
    firstCut = (await svc.recordCut(db, ME, { rollId: roll.id, cutOn: "2026-09-02", lines: [{ cutSizeId: gridSize, qty: 1 }] })).session.id;
    await svc.recordCut(db, ME, { rollId: roll.id, cutOn: "2026-09-03", lines: [{ cutSizeId: gridSize, qty: 2 }] });

    const [product] = await db.insert(schema.products).values({ name: "Dock Mat", productLine: "Test" }).returning();
    productId = product.id;
    await db.insert(schema.productComponents).values({ productId, cutSizeId: gridSize, qty: 1 });
    await setProductSteel(db, { productId, steelItemId: small, qty: 4 });
  });

  it("receives a steel invoice as cost lots with freight spread in", async () => {
    const id = await newDoc();
    expect(await autoReceiveSteel(db, id)).toMatchObject({ status: "registered" });

    const [doc] = await db.select().from(schema.supplierDocuments).where(eq(schema.supplierDocuments.id, id));
    expect(doc).toMatchObject({ invoiceNumber: "S-5001", invoiceDate: "2026-10-01", invoiceTotal: 1320, shippingCost: 120 });
    const lots = await db.select().from(schema.steelLots).where(eq(schema.steelLots.sourceDocumentId, id));
    expect(lots.find((l) => l.steelItemId === small)).toMatchObject({
      qty: 40,
      qtyRemaining: 40,
      unitCost: 18.75,
      freightPerUnit: 1.875,
      landedUnitCost: 20.625,
      receivedOn: "2026-10-01",
      invoiceNumber: "S-5001",
    });
    expect(lots.find((l) => l.steelItemId === large)).toMatchObject({ qty: 20, freightPerUnit: 2.25, landedUnitCost: 24.75 });
    expect(await item(small)).toMatchObject({ onHand: 40, value: 825, latestCost: 20.625 });

    // A Temporal retry changes nothing; the same invoice from another email is a duplicate.
    expect(await autoReceiveSteel(db, id)).toMatchObject({ status: "registered" });
    expect(await autoReceiveSteel(db, await newDoc())).toMatchObject({ status: "duplicate" });
    expect((await item(small)).onHand).toBe(40);
  });

  it("flags invoices it can't check for review", async () => {
    const id = await newDoc({ ...steelInvoice, invoice_number: "S-BAD", invoice_total: 999 });
    expect(await autoReceiveSteel(db, id)).toMatchObject({ status: "needs_review", reason: expect.stringMatching(/invoice total/) });
  });

  it("a sale uses the oldest poles and pieces first and records its steel cost", async () => {
    // A second, cheaper delivery arrives later.
    await adjustSteel(db, ME, { steelItemId: small, qty: 20, reason: "count_correction", unitCost: 20, adjustedOn: "2026-10-05" });

    const one = await recordSale(db, ME, { productId, qty: 1, soldOn: "2026-10-06", source: "manual" });
    expect(one.sale).toMatchObject({ steelCost: 82.5, short: false });
    const sold = await db.select().from(schema.pieces).where(eq(schema.pieces.saleId, one.sale.id));
    expect(sold).toHaveLength(1);
    expect(sold[0]).toMatchObject({ status: "sold", cutOn: "2026-09-02" });

    // 11 more need 44 poles: the 36 left from the invoice lot, then 8 from the newer lot.
    const eleven = await recordSale(db, ME, { productId, qty: 11, soldOn: "2026-10-07", source: "manual" });
    expect(eleven.sale.steelCost).toBe(36 * 20.625 + 8 * 20);
    expect((await item(small)).onHand).toBe(12);
    // Two pieces were in stock; the other nine come off the count, which goes negative.
    expect(await gridOnHand()).toBe(-9);
  });

  it("records an order from a sales channel only once", async () => {
    const a = await recordSale(db, ME, { productId, qty: 1, soldOn: "2026-10-08", source: "shopify", externalRef: "1001" });
    const b = await recordSale(db, ME, { productId, qty: 1, soldOn: "2026-10-08", source: "shopify", externalRef: "1001" });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, sale: { id: a.sale.id } });
    expect((await item(small)).onHand).toBe(8);
  });

  it("never refuses a sale for lack of steel, and fills it in when stock arrives", async () => {
    const short = await recordSale(db, ME, { productId, qty: 3, soldOn: "2026-10-09", source: "manual" });
    expect(short.sale.short).toBe(true);
    expect((await item(small)).onHand).toBe(-4);
    // The 4 missing poles are costed at the latest price for now.
    expect(short.sale.steelCost).toBe(8 * 20 + 4 * 20);

    await adjustSteel(db, ME, { steelItemId: small, qty: 10, reason: "count_correction", unitCost: 25, adjustedOn: "2026-10-10" });
    const [after] = await db.select().from(schema.sales).where(eq(schema.sales.id, short.sale.id));
    expect(after).toMatchObject({ short: false, steelCost: 8 * 20 + 4 * 25 });
    expect(await item(small)).toMatchObject({ onHand: 6, value: 150 });
  });

  it("undoing a sale puts its poles and pieces back", async () => {
    const before = (await item(small)).onHand;
    const grid = await gridOnHand();
    const { sale } = await recordSale(db, ME, { productId, qty: 1, soldOn: "2026-10-11", source: "manual" });
    expect((await item(small)).onHand).toBe(before - 4);
    await voidSale(db, ME, sale.id);
    expect((await item(small)).onHand).toBe(before);
    expect(await gridOnHand()).toBe(grid);
    const usage = await db.select().from(schema.steelUsage).where(and(eq(schema.steelUsage.saleId, sale.id), isNull(schema.steelUsage.voidedAt)));
    expect(usage).toHaveLength(0);
    await expect(voidSale(db, ME, sale.id)).rejects.toThrow(/already undone/);
  });

  it("won't undo a cut whose pieces were sold", async () => {
    await expect(svc.voidCutSession(db, ME, firstCut)).rejects.toThrow(/sold/);
  });

  it("manual steel changes need a cost to add and can't go below zero", async () => {
    await expect(adjustSteel(db, ME, { steelItemId: large, qty: 5, reason: "opening_balance", adjustedOn: "2026-10-12" })).rejects.toThrow(/cost per pole/);
    await expect(adjustSteel(db, ME, { steelItemId: large, qty: -21, reason: "count_correction", adjustedOn: "2026-10-12" })).rejects.toThrow(/Only 20 on hand/);
    await adjustSteel(db, ME, { steelItemId: large, qty: -2, reason: "count_correction", adjustedOn: "2026-10-12", note: "Bent" });
    expect((await item(large)).onHand).toBe(18);
  });

  it("refuses a sale of a product with no recipe", async () => {
    const [bare] = await db.insert(schema.products).values({ name: "Bare", productLine: "Test" }).returning();
    await expect(recordSale(db, ME, { productId: bare.id, qty: 1, soldOn: "2026-10-12", source: "manual" })).rejects.toThrow(/no recipe/);
  });
});
