import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";

import type { EventResult } from "../../shipstation/sync";
import type { SsWebhookBody } from "../../shipstation/types";
import type { Activities } from "../activities";

const acts = proxyActivities<Activities>({
  startToCloseTimeout: "2m",
  retry: { initialInterval: "10s", backoffCoefficient: 2, maximumInterval: "5m", maximumAttempts: 10 },
});

/** One ShipStation webhook: fetch the labels it's about, save their cost and link them to orders. */
export async function shipstationEventWorkflow(input: { body: SsWebhookBody }): Promise<EventResult> {
  try {
    return await acts.shipstationIngestEvent(input.body);
  } catch (err) {
    const cause = err instanceof ApplicationFailure ? err : (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : String(err);
    log.warn("ShipStation event failed", { error: message });
    await acts.shipstationFailed(message);
    throw err;
  }
}
