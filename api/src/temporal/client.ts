import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

import { temporalConfig } from "../config";
import {
  AMAZON_SYNC_NOW_ID,
  type GmailNotification,
  mailboxWorkflowId,
  SHOPIFY_PULL_ID,
  shopifyOrderWorkflowId,
  SIGNALS,
  WORKFLOWS,
} from "./names";

/** Local dev server needs no auth; Temporal Cloud uses TLS + TEMPORAL_API_KEY. */
export function connectionOptions() {
  const c = temporalConfig();
  return { address: c.address, ...(c.apiKey ? { tls: true, apiKey: c.apiKey } : {}) };
}

let cached: Promise<Client> | undefined;

/** One client per process, connected on first use. */
export function temporalClient(): Promise<Client> {
  cached ??= Connection.connect(connectionOptions())
    .then((connection) => new Client({ connection, namespace: temporalConfig().namespace }))
    .catch((err) => {
      cached = undefined;
      throw err;
    });
  return cached;
}

/** Wakes the mailbox's workflow, starting it on the first notification. */
export async function notifyMailbox(n: GmailNotification) {
  const email = n.emailAddress.toLowerCase();
  const client = await temporalClient();
  await client.workflow.signalWithStart(WORKFLOWS.mailbox, {
    workflowId: mailboxWorkflowId(email),
    taskQueue: temporalConfig().taskQueue,
    args: [{ email }],
    signal: SIGNALS.gmailNotification,
    signalArgs: [{ emailAddress: email, historyId: String(n.historyId) }],
  });
}

/** "Sync now": starts an Amazon sync unless one from this button is already running. */
export async function startAmazonSync(): Promise<"started" | "running"> {
  const client = await temporalClient();
  try {
    await client.workflow.start(WORKFLOWS.amazonSync, {
      workflowId: AMAZON_SYNC_NOW_ID,
      taskQueue: temporalConfig().taskQueue,
      workflowIdConflictPolicy: "FAIL",
    });
    return "started";
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return "running";
    throw err;
  }
}

/** A Shopify order webhook: start a run that fetches and saves the order. A repeated delivery is ignored. */
export async function notifyShopifyOrder(orderGid: string, webhookId: string): Promise<void> {
  const client = await temporalClient();
  try {
    await client.workflow.start(WORKFLOWS.shopifyOrder, {
      workflowId: shopifyOrderWorkflowId(orderGid, webhookId),
      taskQueue: temporalConfig().taskQueue,
      args: [{ orderGid }],
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
}

/** "Pull orders": reads Shopify orders updated since a date (or the last pull). */
export async function startShopifyPull(since: string | null): Promise<"started" | "running"> {
  const client = await temporalClient();
  try {
    await client.workflow.start(WORKFLOWS.shopifyPull, {
      workflowId: SHOPIFY_PULL_ID,
      taskQueue: temporalConfig().taskQueue,
      args: [{ since }],
      workflowIdConflictPolicy: "FAIL",
    });
    return "started";
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return "running";
    throw err;
  }
}
