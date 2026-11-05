// Temporal worker: runs the supplier-email workflows. Long-running process
// (docker compose locally, ECS Fargate in production).
import { config } from "dotenv";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { fileURLToPath } from "node:url";

import { ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { orderSource } from "./amazon/order-source";
import { amazonConfig, claudeConfig, temporalConfig } from "./config";
import { getDb } from "./db";
import { mailSource } from "./email/mail-source";
import { getDocument, putDocument } from "./storage";
import { createActivities } from "./temporal/activities";
import { temporalClient, connectionOptions } from "./temporal/client";
import { ClaudeDocumentReader } from "./temporal/extract";
import { AMAZON_SCHEDULE_ID, RENEW_SCHEDULE_ID, WORKFLOWS } from "./temporal/names";

if (process.env.DEV_AUTH_EMAIL && process.env.NODE_ENV !== "development") {
  throw new Error("DEV_AUTH_EMAIL must never be set outside local development.");
}

/** Daily Gmail watch renewal (watches expire after 7 days). Safe to run on every start. */
async function ensureRenewSchedule() {
  const client = await temporalClient();
  try {
    await client.schedule.create({
      scheduleId: RENEW_SCHEDULE_ID,
      spec: { intervals: [{ every: "1d" }] },
      action: { type: "startWorkflow", workflowType: WORKFLOWS.renewWatch, taskQueue: temporalConfig().taskQueue },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
    console.log("Created the daily Gmail watch renewal schedule.");
  } catch (err) {
    if (!(err instanceof ScheduleAlreadyRunning)) throw err;
  }
}

/** Amazon order polling. Removed when AMAZON_MODE=off; the interval follows AMAZON_SYNC_EVERY. */
async function ensureAmazonSchedule() {
  const client = await temporalClient();
  const { mode, syncEvery } = amazonConfig();
  const handle = client.schedule.getHandle(AMAZON_SCHEDULE_ID);
  if (mode === "off") {
    await handle.delete().catch(() => undefined);
    return;
  }
  const spec = { intervals: [{ every: syncEvery as `${number}m` }] };
  try {
    await client.schedule.create({
      scheduleId: AMAZON_SCHEDULE_ID,
      spec,
      action: { type: "startWorkflow", workflowType: WORKFLOWS.amazonSync, taskQueue: temporalConfig().taskQueue },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
    console.log(`Created the Amazon order sync schedule (every ${syncEvery}, ${mode} mode).`);
  } catch (err) {
    if (!(err instanceof ScheduleAlreadyRunning)) throw err;
    await handle.update((prev) => ({ ...prev, spec }));
  }
}

async function main() {
  const db = getDb();
  const activities = createActivities({
    db,
    mail: mailSource(db),
    reader: new ClaudeDocumentReader(claudeConfig().model),
    store: { put: putDocument, get: getDocument },
    orders: orderSource(),
  });
  const c = temporalConfig();
  const worker = await Worker.create({
    connection: await NativeConnection.connect(connectionOptions()),
    namespace: c.namespace,
    taskQueue: c.taskQueue,
    workflowsPath: fileURLToPath(new URL("./temporal/workflows/index.ts", import.meta.url)),
    activities,
  });
  await ensureRenewSchedule();
  await ensureAmazonSchedule();
  console.log(`Worker polling task queue "${c.taskQueue}" on ${c.address}`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
