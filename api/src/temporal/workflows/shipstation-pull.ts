import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";

import type { PullPageResult } from "../../shipstation/sync";
import type { Activities } from "../activities";

const quick = proxyActivities<Activities>({
  startToCloseTimeout: "1m",
  retry: { initialInterval: "5s", maximumAttempts: 5 },
});

const slow = proxyActivities<Activities>({
  startToCloseTimeout: "10m",
  retry: { initialInterval: "10s", backoffCoefficient: 2, maximumInterval: "5m", maximumAttempts: 8 },
});

/**
 * "Re-check shipments": reads every ShipStation label created since a time,
 * re-reads recent voids (they have no webhook) and links labels waiting for
 * their order. Webhooks are the normal path; this is for the first import and gaps.
 */
export async function shipstationPullWorkflow(input: { since?: string | null } = {}): Promise<{ labels: number }> {
  let count = 0;
  try {
    const since = await quick.shipstationPullBegin(input.since ?? null);
    let maxCreated: string | null = null;
    for (let page = 1; ; page++) {
      const r: PullPageResult = await slow.shipstationPullPage(since, page);
      count += r.count;
      if (r.maxCreated && (!maxCreated || r.maxCreated > maxCreated)) maxCreated = r.maxCreated;
      if (page >= r.pages || !r.count) break;
    }
    await slow.shipstationPullEnd(maxCreated, count);
  } catch (err) {
    const cause = err instanceof ApplicationFailure ? err : (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : String(err);
    log.warn("ShipStation re-check failed", { error: message });
    await quick.shipstationFailed(message);
    throw err;
  }
  return { labels: count };
}
