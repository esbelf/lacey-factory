import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";

import type { PullPageResult } from "../../shopify/sync";
import type { Activities } from "../activities";

const quick = proxyActivities<Activities>({
  startToCloseTimeout: "1m",
  retry: { initialInterval: "5s", maximumAttempts: 5 },
});

const page = proxyActivities<Activities>({
  startToCloseTimeout: "5m",
  retry: { initialInterval: "10s", backoffCoefficient: 2, maximumInterval: "5m", maximumAttempts: 8 },
});

/**
 * "Pull orders": reads every Shopify order updated since a time and brings it
 * in. Webhooks are the normal path; this is for the first import and gaps.
 */
export async function shopifyPullWorkflow(input: { since?: string | null } = {}): Promise<{ orders: number; saved: number }> {
  let count = 0;
  let saved = 0;
  try {
    const since = await quick.shopifyPullBegin(input.since ?? null);
    let cursor: string | null = null;
    let maxUpdated: string | null = null;
    do {
      const r: PullPageResult = await page.shopifyPullPage(since, cursor);
      count += r.count;
      saved += r.saved;
      if (r.maxUpdated && (!maxUpdated || r.maxUpdated > maxUpdated)) maxUpdated = r.maxUpdated;
      cursor = r.nextCursor;
    } while (cursor);
    await quick.shopifyPullEnd(maxUpdated, saved);
  } catch (err) {
    const cause = err instanceof ApplicationFailure ? err : (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : String(err);
    log.warn("Shopify pull failed", { error: message });
    await quick.shopifyFailed(message);
    throw err;
  }
  return { orders: count, saved };
}
