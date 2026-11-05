import { Client, Connection } from "@temporalio/client";

import { temporalConfig } from "../config";
import { type GmailNotification, mailboxWorkflowId, SIGNALS, WORKFLOWS } from "./names";

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
