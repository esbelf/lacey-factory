// Parts (stakes, zip ties, clips): stocked by hand at FIFO cost, taken per product sold.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { saveSupplier } from "../src/domain/invoices";
import { listProducts } from "../src/domain/queries";
import { recordSale, voidSale } from "../src/domain/sales";
import { addSupplierSteelProduct, adjustSteel, createSteelItem, setProductSteel, steelSummary } from "../src/domain/steel";

const ME = "eric@lakemat.com";

describe("parts", () => {
  let db: DB;
  let pole: string;
  let stake: string;
  let mat: string;

  const onHand = async (id: string) => (await steelSummary(db)).find((s) => s.id === id)!.onHand;

  beforeAll(async () => {
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    db = pg as unknown as DB;

    pole = (await createSteelItem(db, { name: "Long" })).id;
    stake = (await createSteelItem(db, { name: "Stakes", kind: "part" })).id;
    await adjustSteel(db, ME, { steelItemId: pole, qty: 10, reason: "opening_balance", unitCost: 10, adjustedOn: "2026-09-01" });
    await adjustSteel(db, ME, { steelItemId: stake, qty: 100, reason: "opening_balance", unitCost: 0.25, adjustedOn: "2026-09-01" });

    [{ id: mat }] = await db.insert(schema.products).values({ name: "MuckMat XL", productLine: "MuckMat" }).returning();
    await setProductSteel(db, { productId: mat, steelItemId: pole, qty: 2 });
    await setProductSteel(db, { productId: mat, steelItemId: stake, qty: 4 });
  });

  it("lists parts apart from steel on the product", async () => {
    const [p] = await listProducts(db);
    expect(p).toMatchObject({ steel: [{ steelItemId: pole, qty: 2 }], parts: [{ steelItemId: stake, qty: 4, name: "Stakes" }] });
  });

  it("a sale takes its parts and records their cost apart from steel; undo puts them back", async () => {
    const { sale } = await recordSale(db, ME, { productId: mat, qty: 1, soldOn: "2026-10-01", source: "manual" });
    expect(sale).toMatchObject({ steelCost: 20, partsCost: 1, boxCost: 0, short: false });
    expect(await onHand(stake)).toBe(96);

    await voidSale(db, ME, sale.id);
    expect(await onHand(stake)).toBe(100);
  });

  it("adding parts needs a cost", async () => {
    await expect(
      adjustSteel(db, ME, { steelItemId: stake, qty: 5, reason: "count_correction", adjustedOn: "2026-10-02" }),
    ).rejects.toThrow(/cost of each one/);
  });

  it("a product with only parts has no recipe yet, so it can't be sold", async () => {
    const [{ id }] = await db.insert(schema.products).values({ name: "Clip kit", productLine: "Other" }).returning();
    await setProductSteel(db, { productId: id, steelItemId: stake, qty: 2 });
    await expect(recordSale(db, ME, { productId: id, qty: 1, soldOn: "2026-10-03", source: "manual" })).rejects.toThrow(/no recipe/);
  });

  it("parts can't be mapped to a supplier's invoice codes", async () => {
    const supplierId = await saveSupplier(db, { name: "Pipe Co", emailPatterns: "@pipeco.com", kind: "steel" });
    await expect(addSupplierSteelProduct(db, { supplierId, productCode: "STK", steelItemId: stake })).rejects.toThrow(/pick a pole/);
  });
});
