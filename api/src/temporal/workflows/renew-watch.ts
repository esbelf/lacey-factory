import { log, proxyActivities } from "@temporalio/workflow";

import type { Activities } from "../activities";

const acts = proxyActivities<Activities>({
  startToCloseTimeout: "30s",
  retry: { initialInterval: "5s", maximumAttempts: 5 },
});

/** Gmail watches expire after 7 days; a daily Schedule runs this to renew them. */
export async function renewWatchWorkflow(): Promise<{ renewed: string[]; failed: string[] }> {
  const renewed: string[] = [];
  const failed: string[] = [];
  for (const email of await acts.listConnectedAccounts()) {
    try {
      await acts.renewWatch(email);
      renewed.push(email);
    } catch (err) {
      log.warn("Could not renew Gmail watch", { email, error: String(err) });
      failed.push(email);
    }
  }
  return { renewed, failed };
}
