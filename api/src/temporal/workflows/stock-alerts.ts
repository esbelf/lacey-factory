import { proxyActivities } from "@temporalio/workflow";

import type { Activities } from "../activities";

const acts = proxyActivities<Activities>({
  startToCloseTimeout: "1m",
  retry: { initialInterval: "10s", maximumAttempts: 5 },
});

/** Low-stock Slack alerts; the stock-alerts Schedule runs this every 15 minutes. */
export async function stockAlertsWorkflow() {
  return acts.checkStockLevels();
}
