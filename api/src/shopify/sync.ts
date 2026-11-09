// Shopify orders into the database. Webhooks call ingestOrder for one order;
// "Pull orders" pages through everything updated since a time (begin → page → end).
import { shopifyConfig } from "../config";
import type { DB } from "../db/types";
import { applyOrder, findOrder, markSyncDone, markSyncStarted, retryProblems, saveOrder, syncState, wantedState } from "../domain/orders";
import { normalizeShopifyOrder } from "./normalize";
import type { ShopifySource } from "./order-source";
import type { ShopifyOrder } from "./types";

/** Re-read a few minutes before the last pull in case Shopify was slow to show an update. */
const OVERLAP_MS = 5 * 60_000;

export type IngestResult = "saved" | "unchanged" | "skipped";

/**
 * Save one order and bring stock in line with it. Orders we haven't seen are
 * only saved once paid; an order we already have is always updated (so a
 * refund or cancel undoes its sale).
 */
export async function ingestOrder(db: DB, o: ShopifyOrder): Promise<IngestResult> {
  const n = normalizeShopifyOrder(o);
  const saved = await findOrder(db, "shopify", o.id);
  if (!saved && wantedState("shopify", n.order.status, n.order.canceledAt) !== "paid") return "skipped";
  if (saved && saved.lastUpdatedAt.getTime() >= n.order.lastUpdatedAt.getTime()) {
    await applyOrder(db, saved.id); // nothing new; just make sure stock matches
    return "unchanged";
  }
  const { id, changed } = await saveOrder(db, n);
  await applyOrder(db, id);
  return changed ? "saved" : "unchanged";
}

/** Fetch an order by GID (from a webhook) and ingest it. */
export async function ingestOrderById(db: DB, source: ShopifySource, gid: string): Promise<IngestResult> {
  const o = await source.getOrder(gid);
  if (!o) return "skipped";
  const r = await ingestOrder(db, o);
  if (r === "saved") await markSyncDone(db, "shopify", { cursor: null, ordersSeen: 1 });
  return r;
}

/** Where a pull starts (ISO time): the given date, else just before the last pull, else SHOPIFY_PULL_START or 30 days back. */
export async function pullBegin(db: DB, since: string | null, now = new Date()): Promise<string> {
  await markSyncStarted(db, "shopify");
  if (since) return new Date(since).toISOString();
  const state = await syncState(db, "shopify");
  const start = state?.cursor
    ? new Date(state.cursor.getTime() - OVERLAP_MS)
    : shopifyConfig().pullStart
      ? new Date(shopifyConfig().pullStart as string)
      : new Date(now.getTime() - 30 * 24 * 3600_000);
  return start.toISOString();
}

export type PullPageResult = { nextCursor: string | null; maxUpdated: string | null; count: number; saved: number };

export async function pullPage(db: DB, source: ShopifySource, since: string, cursor: string | null): Promise<PullPageResult> {
  const page = await source.listOrders(since, cursor);
  let maxUpdated: string | null = null;
  let saved = 0;
  for (const o of page.orders) {
    if (!maxUpdated || o.updatedAt > maxUpdated) maxUpdated = o.updatedAt;
    if ((await ingestOrder(db, o)) === "saved") saved++;
  }
  return { nextCursor: page.nextCursor, maxUpdated, count: page.orders.length, saved };
}

/** Move the pull cursor and retry lines waiting on a SKU link or recipe. */
export async function pullEnd(db: DB, maxUpdated: string | null, saved: number) {
  await retryProblems(db);
  await markSyncDone(db, "shopify", { cursor: maxUpdated ? new Date(maxUpdated) : null, ordersSeen: saved });
}
