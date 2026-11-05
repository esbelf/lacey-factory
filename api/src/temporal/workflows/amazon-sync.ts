import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";

import type { PageResult } from "../../amazon/sync";
import type { Activities } from "../activities";

const quick = proxyActivities<Activities>({
  startToCloseTimeout: "1m",
  retry: { initialInterval: "5s", maximumAttempts: 5 },
});

// A page fetches up to 100 orders' items at ~0.5 calls/second, so it can take minutes.
// Amazon's order list refills one call a minute, so throttled pages back off for a while.
const page = proxyActivities<Activities>({
  startToCloseTimeout: "15m",
  retry: { initialInterval: "30s", backoffCoefficient: 2, maximumInterval: "5m", maximumAttempts: 8 },
});

/** Reads Amazon orders updated since the last run and records their sales. Run every 15 minutes by a Schedule. */
export async function amazonSyncWorkflow(): Promise<{ orders: number }> {
  let count = 0;
  try {
    const since = await quick.amazonSyncBegin();
    let nextToken: string | null = null;
    let maxUpdated: string | null = null;
    do {
      const r: PageResult = await page.amazonSyncPage(since, nextToken);
      count += r.count;
      if (r.maxUpdated && (!maxUpdated || r.maxUpdated > maxUpdated)) maxUpdated = r.maxUpdated;
      nextToken = r.nextToken;
    } while (nextToken);
    await quick.amazonSyncEnd(maxUpdated, count);
  } catch (err) {
    const cause = err instanceof ApplicationFailure ? err : (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : String(err);
    log.warn("Amazon sync failed", { error: message });
    await quick.amazonSyncFailed(message);
    throw err;
  }
  return { orders: count };
}
