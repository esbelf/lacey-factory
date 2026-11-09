import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";

import type { IngestResult } from "../../shopify/sync";
import type { Activities } from "../activities";

// Shopify allows ~2 calls a second; throttled calls back off and try again.
const acts = proxyActivities<Activities>({
  startToCloseTimeout: "1m",
  retry: { initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "5m", maximumAttempts: 10 },
});

/** One Shopify webhook: fetch the order as it is now, save it and update stock. */
export async function shopifyOrderWorkflow(input: { orderGid: string }): Promise<IngestResult> {
  try {
    return await acts.shopifyIngestOrder(input.orderGid);
  } catch (err) {
    const cause = err instanceof ApplicationFailure ? err : (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : String(err);
    log.warn("Shopify order failed", { order: input.orderGid, error: message });
    await acts.shopifyFailed(`Order ${input.orderGid}: ${message}`);
    throw err;
  }
}
