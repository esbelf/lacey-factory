// Fabric and sewing cost of goods sold: FIFO by piece, priced from each piece's roll.
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { pieceCost, setRollCost, sewingCost } from "../src/domain/cogs";
import { rollCosts } from "../src/domain/invoices";
import { recordSale } from "../src/domain/sales";
import * as svc from "../src/domain/services";

const ME = "eric@lakemat.com";

describe("cost helpers", () => {
  it("prices a piece by the feet it took off its roll", () => {
    // $1,200 for 300' is $4/ft, so a 26' cut is $104 whatever its width.
    expect(pieceCost(26, { cost: 1200, lengthFt: 300 })).toBe(104);
    expect(pieceCost(26, { cost: null, lengthFt: 300 })).toBeNull();
  });

  it("charges sewing by who sewed the pieces", () => {
    const rates = { inHouse: 10, summit: 15 };
    expect(sewingCost(2, true, { inHouse: 1, summit: 1 }, rates)).toEqual({ cost: 25, missing: false });
    expect(sewingCost(3, true, { inHouse: 0, summit: 3 }, rates)).toEqual({ cost: 45, missing: false });
    // Nothing in stock: assumed sewn in-house.
    expect(sewingCost(1, true, { inHouse: 0, summit: 0 }, rates)).toEqual({ cost: 10, missing: false });
    // Unsewn products (geogrid, SandMat) cost nothing to sew.
    expect(sewingCost(4, false, { inHouse: 0, summit: 0 }, rates)).toEqual({ cost: 0, missing: false });
    expect(sewingCost(1, true, { inHouse: 0, summit: 1 }, { inHouse: 10, summit: null })).toEqual({ cost: 0, missing: true });
  });

  it("adds each roll's share of invoice freight, split by line value", () => {
    const roll = { materialId: "m", widthFt: 12, lengthFt: 300, supplierRollNo: null };
    const planned = [
      { ...roll, unitCost: 1000, line: 0 },
      { ...roll, unitCost: 1000, line: 0 },
      { ...roll, unitCost: 2000, line: 1 },
      { ...roll, unitCost: null, line: 2 },
    ];
    // $400 freight over $4,000 of rolls: line 0 gets $200 (two rolls), line 1 gets $200.
    expect(rollCosts(planned, 400)).toEqual([1100, 1100, 2200, null]);
    expect(rollCosts(planned, null)).toEqual([1000, 1000, 2000, null]);
  });
});

describe("cost of a sale", () => {
  let db: DB;
  let size: string;
  let materialId: string;
  let productId: string;

  const sale = async (qty: number, soldOn: string, id = productId) => {
    const { sale } = await recordSale(db, ME, { productId: id, qty, soldOn, source: "manual" });
    return sale;
  };
  const reload = async (id: string) => (await db.select().from(schema.sales).where(eq(schema.sales.id, id)))[0];

  beforeAll(async () => {
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    db = pg as unknown as DB;

    materialId = (await svc.createMaterial(db, { name: "N06", requiresSewing: true })).id;
    size = (await svc.createCutSize(db, { materialId, label: "12x24", widthFt: 12, cutLengthFt: 26 })).id;

    // Roll A: $4/ft, cut first and sewn in-house. Roll B: $5/ft, cut later and sewn at Summit.
    const a = await svc.createRoll(db, ME, { materialId, widthFt: 12, lengthFt: 300, receivedOn: "2026-09-01", cost: 1200 });
    await svc.recordCut(db, ME, { rollId: a.id, cutOn: "2026-09-02", lines: [{ cutSizeId: size, qty: 2 }] });
    const b = await svc.createRoll(db, ME, { materialId, widthFt: 12, lengthFt: 300, receivedOn: "2026-09-10", cost: 1500 });
    await svc.recordCut(db, ME, { rollId: b.id, cutOn: "2026-09-11", lines: [{ cutSizeId: size, qty: 2 }] });
    await svc.markSewnInHouse(db, ME, { sewnOn: "2026-09-12", lines: [{ cutSizeId: size, qty: 2 }] });
    await svc.sendToSummit(db, ME, { sentOn: "2026-09-12", lines: [{ cutSizeId: size, qty: 2 }] });
    await svc.receiveFromSummit(db, ME, { cutSizeId: size, qty: 2, receivedOn: "2026-09-20" });

    const [p] = await db
      .insert(schema.products)
      .values({ name: "LakeMat XL", productLine: "LakeMat", sewCostInHouse: 10, sewCostSummit: 15 })
      .returning();
    productId = p.id;
    await db.insert(schema.productComponents).values({ productId, cutSizeId: size, qty: 1 });
  });

  it("costs the oldest piece first, from its own roll, with in-house sewing", async () => {
    const s = await sale(1, "2026-10-01");
    expect(s).toMatchObject({ fabricCost: 104, fabricCostMissing: false, sewingCost: 10, sewingCostMissing: false });
  });

  it("mixes rolls and sewers when a sale spans them", async () => {
    // Last roll-A piece (in-house, $104) + first roll-B piece (Summit, 26 × $5 = $130).
    const s = await sale(2, "2026-10-02");
    expect(s).toMatchObject({ fabricCost: 234, sewingCost: 25 });
  });

  it("estimates pieces it was short of from the newest priced roll", async () => {
    // One roll-B piece left: $130, plus one missing piece estimated at roll B's $5/ft.
    const s = await sale(2, "2026-10-03");
    expect(s).toMatchObject({ fabricCost: 260, fabricCostMissing: false, sewingCost: 30 });
  });

  it("fills in the fabric cost when an unpriced roll gets its price", async () => {
    const c = await svc.createRoll(db, ME, { materialId, widthFt: 12, lengthFt: 300, receivedOn: "2026-10-05" });
    await svc.recordCut(db, ME, { rollId: c.id, cutOn: "2026-10-06", lines: [{ cutSizeId: size, qty: 1 }] });
    await svc.markSewnInHouse(db, ME, { sewnOn: "2026-10-07", lines: [{ cutSizeId: size, qty: 1 }] });
    // Roll C has no price yet, so this sale's fabric cost is flagged as missing.
    const s = await sale(1, "2026-10-08");
    expect(s).toMatchObject({ fabricCost: 0, fabricCostMissing: true });

    await setRollCost(db, c.id, 600); // $2/ft → $52
    expect(await reload(s.id)).toMatchObject({ fabricCost: 52, fabricCostMissing: false });
  });

  it("flags a missing sewing rate", async () => {
    const [p] = await db.insert(schema.products).values({ name: "No rates", productLine: "Test" }).returning();
    await db.insert(schema.productComponents).values({ productId: p.id, cutSizeId: size, qty: 1 });
    const s = await sale(1, "2026-10-09", p.id);
    expect(s).toMatchObject({ sewingCost: 0, sewingCostMissing: true });
  });
});
