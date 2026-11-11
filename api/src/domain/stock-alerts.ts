// Low-stock Slack alerts for poles, boxes and parts: one alert when an item drops
// to its reorder level, a reminder each Monday while it stays low, and a note when
// it's back above the level. Run every 15 minutes by the stock-alerts schedule.
import { todayInMichigan } from "@lacey-factory/shared/feet";
import { eq, inArray } from "drizzle-orm";

import { slackConfig } from "../config";
import { steelItems } from "../db/schema";
import type { DB } from "../db/types";
import type { Notify } from "../slack";
import { steelSummary } from "./steel";

/** Monday reminders go out from this hour on, Michigan time. */
const REMINDER_HOUR = 8;

function michiganClock(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Detroit",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")), today: todayInMichigan(now) };
}

const count = (n: number) => n.toLocaleString("en-US");

type Item = Awaited<ReturnType<typeof steelSummary>>[number];
const line = (i: Item) => `• *${i.name}*: ${count(i.onHand)} on hand (reorder level ${count(i.reorderLevel ?? 0)})`;

export type StockAlertResult = { alerted: string[]; reminded: string[]; restocked: string[] };

export async function checkStockLevels(db: DB, notify: Notify, now = new Date()): Promise<StockAlertResult> {
  const { weekday, hour, today } = michiganClock(now);
  const link = `${slackConfig().appBaseUrl}/inventory`;
  const items = await steelSummary(db);
  const watched = (i: Item) => i.active && i.reorderLevel != null;
  const isLow = (i: Item) => watched(i) && i.onHand <= (i.reorderLevel as number);

  const newlyLow = items.filter((i) => isLow(i) && !i.lowAlertedAt);
  const restocked = items.filter((i) => i.lowAlertedAt && watched(i) && !isLow(i));
  const dropped = items.filter((i) => i.lowAlertedAt && !watched(i));
  const due =
    weekday === "Mon" && hour >= REMINDER_HOUR
      ? items.filter((i) => isLow(i) && i.lowAlertedAt && (i.lowRemindedOn ?? "") < today)
      : [];

  // Each message goes out before its state is saved, so a Slack failure retries next run.
  if (newlyLow.length) {
    await notify([`:warning: *Time to reorder*`, ...newlyLow.map(line), `<${link}|Open inventory>`].join("\n"));
    await db
      .update(steelItems)
      .set({ lowAlertedAt: now, lowRemindedOn: today })
      .where(inArray(steelItems.id, newlyLow.map((i) => i.id)));
  }
  if (due.length) {
    const all = items.filter((i) => isLow(i) && i.lowAlertedAt);
    await notify(
      [
        `:calendar: *Weekly reminder: still low*`,
        ...all.map((i) => `${line(i)}, low since ${todayInMichigan(i.lowAlertedAt as Date)}`),
        `<${link}|Open inventory>`,
      ].join("\n"),
    );
    await db.update(steelItems).set({ lowRemindedOn: today }).where(inArray(steelItems.id, all.map((i) => i.id)));
  }
  if (restocked.length) {
    await notify(
      [`:white_check_mark: *Back in stock*`, ...restocked.map((i) => `• *${i.name}*: ${count(i.onHand)} on hand`)].join("\n"),
    );
  }
  for (const i of [...restocked, ...dropped]) {
    await db.update(steelItems).set({ lowAlertedAt: null, lowRemindedOn: null }).where(eq(steelItems.id, i.id));
  }
  return {
    alerted: newlyLow.map((i) => i.name),
    reminded: due.length ? items.filter((i) => isLow(i) && i.lowAlertedAt).map((i) => i.name) : [],
    restocked: restocked.map((i) => i.name),
  };
}
