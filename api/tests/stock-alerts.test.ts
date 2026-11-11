// Low-stock Slack alerts: first alert, Monday reminders, back in stock.
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { checkStockLevels } from "../src/domain/stock-alerts";
import { adjustSteel, createSteelItem, updateSteelItem } from "../src/domain/steel";

const ME = "eric@lakemat.com";
// Michigan is UTC-5 in November.
const at = (iso: string) => new Date(`${iso}-05:00`);
const WED = at("2026-11-11T10:00:00");
const MON = at("2026-11-16T09:00:00");
const MON_EARLY = at("2026-11-16T07:00:00");
const TUE = at("2026-11-17T09:00:00");
const NEXT_MON = at("2026-11-23T09:00:00");

describe("low-stock alerts", () => {
  let db: DB;
  let box: string;
  let sent: string[];
  const notify = async (text: string) => {
    sent.push(text);
  };
  const check = (now: Date) => checkStockLevels(db, notify, now);
  const change = (qty: number, on = "2026-11-10") =>
    adjustSteel(db, ME, { steelItemId: box, qty, reason: "count_correction", unitCost: qty > 0 ? 3 : undefined, adjustedOn: on });
  const state = async () => (await db.select().from(schema.steelItems).where(eq(schema.steelItems.id, box)))[0];

  beforeEach(async () => {
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    db = pg as unknown as DB;
    sent = [];
    box = (await createSteelItem(db, { name: "LAKEMAT BOX", kind: "box", reorderLevel: 500 })).id;
    await adjustSteel(db, ME, { steelItemId: box, qty: 600, reason: "opening_balance", unitCost: 3, adjustedOn: "2026-11-01" });
  });

  it("stays quiet above the level", async () => {
    await check(WED);
    expect(sent).toEqual([]);
  });

  it("alerts once at the level, then reminds each Monday until restocked", async () => {
    await change(-100); // 500: at the level counts as low
    expect(await check(WED)).toMatchObject({ alerted: ["LAKEMAT BOX"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Time to reorder");
    expect(sent[0]).toContain("LAKEMAT BOX*: 500 on hand (reorder level 500)");

    await check(WED);
    await check(MON_EARLY); // before 8am
    expect(sent).toHaveLength(1);

    await check(MON);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Weekly reminder");
    expect(sent[1]).toContain("low since 2026-11-11");
    await check(MON);
    await check(TUE);
    expect(sent).toHaveLength(2);

    await check(NEXT_MON);
    expect(sent).toHaveLength(3);

    await change(1000);
    expect(await check(NEXT_MON)).toMatchObject({ restocked: ["LAKEMAT BOX"] });
    expect(sent[3]).toContain("Back in stock");
    expect(await state()).toMatchObject({ lowAlertedAt: null, lowRemindedOn: null });

    await change(-1100); // 400: low again, alerts again
    await check(NEXT_MON);
    expect(sent[4]).toContain("Time to reorder");
  });

  it("an item that first goes low on a Monday gets no reminder that day", async () => {
    await change(-200);
    await check(MON);
    await check(MON);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Time to reorder");
  });

  it("a Slack failure saves nothing, so the next run sends it", async () => {
    await change(-200);
    await expect(checkStockLevels(db, async () => Promise.reject(new Error("Slack down")), WED)).rejects.toThrow("Slack down");
    expect((await state()).lowAlertedAt).toBeNull();
    await check(WED);
    expect(sent).toHaveLength(1);
  });

  it("removing the level clears the alert without a message", async () => {
    await change(-200);
    await check(WED);
    await updateSteelItem(db, box, { name: "LAKEMAT BOX", sortOrder: 0, active: true, reorderLevel: null });
    await check(MON);
    expect(sent).toHaveLength(1);
    expect(await state()).toMatchObject({ lowAlertedAt: null, lowRemindedOn: null });
  });
});
