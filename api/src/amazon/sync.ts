// One Amazon sync run, in steps the Temporal workflow calls as activities:
// begin (where to start) → page (save + apply up to 100 orders) → end (move the cursor).
import { amazonConfig } from "../config";
import type { DB } from "../db/types";
import { applyOrder, findOrder, markSyncDone, markSyncStarted, retryProblems, saveOrder, syncState } from "../domain/orders";
import { normalizeAmazonOrder } from "./normalize";
import type { OrderSource } from "./order-source";

/** Amazon wants LastUpdatedAfter at least 2 minutes in the past. */
const MIN_LAG_MS = 2 * 60_000;
/** Re-read a few minutes before the cursor in case Amazon was slow to show an update. */
const OVERLAP_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where this run starts reading (ISO time). */
export async function syncBegin(db: DB, now = new Date()): Promise<string> {
  await markSyncStarted(db, "amazon");
  const state = await syncState(db, "amazon");
  const start = state?.cursor
    ? new Date(state.cursor.getTime() - OVERLAP_MS)
    : amazonConfig().syncStart
      ? new Date(amazonConfig().syncStart as string)
      : new Date(now.getTime() - 30 * 24 * 3600_000);
  const latest = new Date(now.getTime() - MIN_LAG_MS);
  return (start < latest ? start : latest).toISOString();
}

export type PageResult = { nextToken: string | null; maxUpdated: string | null; count: number };

/** Fetch one page of orders and bring each into the database. Unchanged orders skip the item call. */
export async function syncPage(db: DB, source: OrderSource, since: string, nextToken: string | null): Promise<PageResult> {
  const page = await source.listOrders(since, nextToken);
  let maxUpdated: string | null = null;
  for (const o of page.orders) {
    if (!maxUpdated || o.LastUpdateDate > maxUpdated) maxUpdated = o.LastUpdateDate;
    const saved = await findOrder(db, "amazon", o.AmazonOrderId);
    if (saved && saved.lastUpdatedAt.getTime() >= new Date(o.LastUpdateDate).getTime()) {
      await applyOrder(db, saved.id);
      continue;
    }
    const items = await source.getOrderItems(o.AmazonOrderId);
    if (source.itemDelayMs) await sleep(source.itemDelayMs);
    const { id } = await saveOrder(db, normalizeAmazonOrder(o, items));
    await applyOrder(db, id);
  }
  return { nextToken: page.nextToken, maxUpdated, count: page.orders.length };
}

/** Save the cursor and retry lines waiting on a SKU link or recipe. */
export async function syncEnd(db: DB, maxUpdated: string | null, count: number) {
  await retryProblems(db);
  await markSyncDone(db, "amazon", { cursor: maxUpdated ? new Date(maxUpdated) : null, ordersSeen: count });
}
