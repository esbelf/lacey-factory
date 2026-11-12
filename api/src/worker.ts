// Temporal worker: runs the supplier-email and sales-channel workflows. Long-running process
// (docker compose locally, ECS Fargate in production).
import { config } from "dotenv";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { fileURLToPath } from "node:url";

import { ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { orderSource } from "./amazon/order-source";
import { amazonConfig, claudeConfig, shipstationConfig, shopifyConfig, temporalConfig } from "./config";
import { getDb } from "./db";
import { mailSource } from "./email/mail-source";
import { type ShipStationSource, shipstationSource } from "./shipstation/source";
import { type ShopifySource, shopifySource } from "./shopify/order-source";
import { getDocument, putDocument } from "./storage";
import { createActivities } from "./temporal/activities";
import { temporalClient, connectionOptions } from "./temporal/client";
import { ClaudeDocumentReader } from "./temporal/extract";
import { AMAZON_SCHEDULE_ID, RENEW_SCHEDULE_ID, STOCK_ALERT_SCHEDULE_ID, WORKFLOWS } from "./temporal/names";

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

/** Low-stock Slack alerts: checked every 15 minutes. Safe to run on every start. */
async function ensureStockAlertSchedule() {
  const client = await temporalClient();
  try {
    await client.schedule.create({
      scheduleId: STOCK_ALERT_SCHEDULE_ID,
      spec: { intervals: [{ every: "15m" }] },
      action: { type: "startWorkflow", workflowType: WORKFLOWS.stockAlerts, taskQueue: temporalConfig().taskQueue },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
    console.log("Created the low-stock alert schedule (every 15 minutes).");
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

/**
 * Shopify order webhooks (live mode). Adds any missing subscription, which also
 * restores ones Shopify dropped after repeated failed deliveries. A problem
 * here is logged, not fatal: the worker also handles email and Amazon.
 */
async function ensureShopifyWebhooks(source: ShopifySource | null) {
  const { mode, webhookUrl } = shopifyConfig();
  if (mode !== "live" || !source) return;
  if (!webhookUrl) {
    console.warn("SHOPIFY_WEBHOOK_URL isn't set, so Shopify webhooks weren't registered.");
    return;
  }
  try {
    const added = await source.ensureWebhooks(webhookUrl);
    console.log(added.length ? `Subscribed Shopify webhooks: ${added.join(", ")}.` : "Shopify webhooks are in place.");
  } catch (err) {
    console.error("Couldn't register Shopify webhooks:", err instanceof Error ? err.message : err);
  }
}

/**
 * ShipStation label and shipped webhooks (live mode). ShipStation keeps one URL
 * per event per account, so an event already sent somewhere else (e.g. the
 * other environment) is left alone and logged. Problems are logged, not fatal.
 */
async function ensureShipStationWebhooks(source: ShipStationSource | null) {
  const { mode, webhookUrl } = shipstationConfig();
  if (mode !== "live" || !source) return;
  if (!webhookUrl) {
    console.warn("SHIPSTATION_WEBHOOK_URL isn't set, so ShipStation webhooks weren't registered.");
    return;
  }
  try {
    const { added, elsewhere } = await source.ensureWebhooks(webhookUrl);
    console.log(added.length ? `Subscribed ShipStation webhooks: ${added.join(", ")}.` : "ShipStation webhooks checked.");
    for (const e of elsewhere) {
      console.warn(`ShipStation ${e.event} already goes to ${e.url}, not ${webhookUrl}. Left as is (one URL per event).`);
    }
  } catch (err) {
    console.error("Couldn't register ShipStation webhooks:", err instanceof Error ? err.message : err);
  }
}

async function main() {
  const db = getDb();
  const shopify = shopifySource();
  const shipstation = shipstationSource();
  const activities = createActivities({
    db,
    mail: mailSource(db),
    reader: new ClaudeDocumentReader(claudeConfig().model),
    store: { put: putDocument, get: getDocument },
    orders: orderSource(),
    shopify,
    shipstation,
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
  await ensureStockAlertSchedule();
  await ensureShopifyWebhooks(shopify);
  await ensureShipStationWebhooks(shipstation);
  console.log(`Worker polling task queue "${c.taskQueue}" on ${c.address}`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
