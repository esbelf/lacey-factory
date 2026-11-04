// End-to-end production flow against a real Postgres (PGlite, in-process).
// Cut lengths here are test values, not Lacey's real numbers.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { getRoll, listRolls, pipelineBySize } from "../src/domain/queries";
import * as svc from "../src/domain/services";

const ME = "eric@lakemat.com";
let db: DB;
let fabricId: string;
let geogridId: string;
const size: Record<string, string> = {};

async function stage(label: string) {
  const rows = await pipelineBySize(db);
  return rows.find((r) => r.cutSizeId === size[label])!;
}

beforeAll(async () => {
  const client = new PGlite();
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "drizzle" });
  db = pg as unknown as DB;

  fabricId = (await svc.createMaterial(db, { name: "Fabric", requiresSewing: true, defaultWidthFt: 12.5 })).id;
  geogridId = (await svc.createMaterial(db, { name: "Geogrid", requiresSewing: false })).id;
  for (const [label, len, order] of [
    ["12x24", 26, 1],
    ["12x19", 21, 2],
    ["12x14", 16, 3],
  ] as const) {
    size[label] = (
      await svc.createCutSize(db, { materialId: fabricId, label, widthFt: 12, cutLengthFt: len, sortOrder: order })
    ).id;
  }
  size.grid24 = (await svc.createCutSize(db, { materialId: geogridId, label: "12x24", widthFt: 12, cutLengthFt: 24 })).id;
});

describe("production flow", () => {
  let rollId: string;

  it("registers a roll as uncut with a generated code", async () => {
    const roll = await svc.createRoll(db, ME, {
      materialId: fabricId,
      supplierRollNo: "2YZ",
      widthFt: 12.5,
      lengthFt: 360,
      receivedOn: "2026-10-01",
    });
    rollId = roll.id;
    expect(roll.appCode).toBe("R-0001");
    const [listed] = await listRolls(db);
    expect(listed.status).toBe("uncut");
    expect(listed.remainingFt).toBe(360);
  });

  it("cuts in several sessions and tracks what's left", async () => {
    await svc.recordCut(db, ME, { rollId, cutOn: "2026-10-02", lines: [{ cutSizeId: size["12x24"], qty: 2 }] });
    let roll = await getRoll(db, rollId);
    expect(roll!.remainingFt).toBe(308);
    expect(roll!.status).toBe("partially_cut");

    // 308 / 21 = 14.67 → 15 won't fit, 14 will.
    await expect(
      svc.recordCut(db, ME, { rollId, cutOn: "2026-10-04", lines: [{ cutSizeId: size["12x19"], qty: 15 }] }),
    ).rejects.toThrow(/only 308' is left/);
    await svc.recordCut(db, ME, { rollId, cutOn: "2026-10-04", lines: [{ cutSizeId: size["12x19"], qty: 14 }] });
    roll = await getRoll(db, rollId);
    expect(roll!.remainingFt).toBe(14);
    expect(roll!.totals).toEqual([
      { label: "12x24", qty: 2, feet: 52 },
      { label: "12x19", qty: 14, feet: 294 },
    ]);
    expect((await stage("12x19")).cut).toBe(14);
  });

  it("rejects sizes from another material and cut dates before receipt", async () => {
    await expect(
      svc.recordCut(db, ME, { rollId, cutOn: "2026-10-05", lines: [{ cutSizeId: size.grid24, qty: 1 }] }),
    ).rejects.toThrow(/doesn't belong/);
    await expect(
      svc.recordCut(db, ME, { rollId, cutOn: "2026-09-01", lines: [{ cutSizeId: size["12x14"], qty: 1 }] }),
    ).rejects.toThrow(/before the roll was received/);
  });

  it("sews in-house into inventory", async () => {
    await svc.markSewnInHouse(db, ME, { sewnOn: "2026-10-06", lines: [{ cutSizeId: size["12x19"], qty: 5 }] });
    const s = await stage("12x19");
    expect(s).toMatchObject({ cut: 9, inStockPieces: 5, onHand: 5 });
    await expect(
      svc.markSewnInHouse(db, ME, { sewnOn: "2026-10-06", lines: [{ cutSizeId: size["12x19"], qty: 10 }] }),
    ).rejects.toThrow(/Only 9/);
  });

  it("sends to Summit and receives FIFO", async () => {
    // Second roll cut later, so we can see FIFO pick the older roll's pieces.
    const roll2 = await svc.createRoll(db, ME, { materialId: fabricId, widthFt: 12.5, lengthFt: 360, receivedOn: "2026-10-07" });
    await svc.recordCut(db, ME, { rollId: roll2.id, cutOn: "2026-10-08", lines: [{ cutSizeId: size["12x19"], qty: 6 }] });

    await svc.sendToSummit(db, ME, { sentOn: "2026-10-09", lines: [{ cutSizeId: size["12x19"], qty: 9 }] });
    await svc.sendToSummit(db, ME, { sentOn: "2026-10-10", lines: [{ cutSizeId: size["12x19"], qty: 6 }] });
    expect(await stage("12x19")).toMatchObject({ cut: 0, atSummit: 15, oldestSentToSummit: "2026-10-09" });

    await expect(
      svc.receiveFromSummit(db, ME, { cutSizeId: size["12x19"], qty: 16, receivedOn: "2026-10-20" }),
    ).rejects.toThrow(/Only 15/);

    await svc.receiveFromSummit(db, ME, { cutSizeId: size["12x19"], qty: 10, receivedOn: "2026-10-20" });
    expect(await stage("12x19")).toMatchObject({ atSummit: 5, onHand: 15, oldestSentToSummit: "2026-10-10" });

    // The 9 from the first shipment (roll 1) must all have been received first.
    const rows = await db.select().from(schema.pieces);
    const firstRollAtSummit = rows.filter((p) => p.rollId === rollId && p.status === "at_summit");
    expect(firstRollAtSummit).toHaveLength(0);
  });

  it("blocks undoing a cut whose pieces moved on, allows it otherwise", async () => {
    const roll = await getRoll(db, rollId);
    const day3 = roll!.sessions.find((s) => s.cutOn === "2026-10-04")!;
    await expect(svc.voidCutSession(db, ME, day3.id)).rejects.toThrow(/Undo that first/);

    const day1 = roll!.sessions.find((s) => s.cutOn === "2026-10-02")!;
    await svc.voidCutSession(db, ME, day1.id);
    expect((await getRoll(db, rollId))!.remainingFt).toBe(66);
    expect((await stage("12x24")).cut).toBe(0);
  });

  it("undoes a Summit receipt back to 'at Summit'", async () => {
    const r = await svc.receiveFromSummit(db, ME, { cutSizeId: size["12x19"], qty: 5, receivedOn: "2026-10-21" });
    expect((await stage("12x19")).atSummit).toBe(0);
    await svc.voidSummitReceipt(db, ME, r.id);
    expect(await stage("12x19")).toMatchObject({ atSummit: 5, onHand: 15 });
  });

  it("puts geogrid cuts straight into inventory", async () => {
    const g = await svc.createRoll(db, ME, { materialId: geogridId, widthFt: 12, lengthFt: 100, receivedOn: "2026-10-01" });
    await svc.recordCut(db, ME, { rollId: g.id, cutOn: "2026-10-02", lines: [{ cutSizeId: size.grid24, qty: 4 }] });
    expect(await stage("grid24")).toMatchObject({ cut: 0, onHand: 4 });
    // Geogrid cuts can still be undone even though they're "in stock".
    const roll = await getRoll(db, g.id);
    await svc.voidCutSession(db, ME, roll!.sessions[0].id);
    expect((await stage("grid24")).onHand).toBe(0);
  });

  it("applies inventory adjustments and never goes negative", async () => {
    await svc.adjustInventory(db, ME, { cutSizeId: size["12x14"], qty: 30, reason: "opening_balance", adjustedOn: "2026-10-27" });
    await svc.adjustInventory(db, ME, { cutSizeId: size["12x14"], qty: -2, reason: "count_correction", adjustedOn: "2026-10-27" });
    expect((await stage("12x14")).onHand).toBe(28);
    await expect(
      svc.adjustInventory(db, ME, { cutSizeId: size["12x14"], qty: -29, reason: "other", adjustedOn: "2026-10-27" }),
    ).rejects.toThrow(/Only 28 on hand/);
  });

  it("closes and reopens a roll", async () => {
    await svc.closeRoll(db, { rollId, closedOn: "2026-10-22", leftoverFtMeasured: 13.5 });
    await expect(
      svc.recordCut(db, ME, { rollId, cutOn: "2026-10-23", lines: [{ cutSizeId: size["12x14"], qty: 1 }] }),
    ).rejects.toThrow(/closed out/);
    expect((await getRoll(db, rollId))!.status).toBe("closed");
    await svc.reopenRoll(db, rollId);
    expect((await getRoll(db, rollId))!.status).toBe("partially_cut");
  });
});
