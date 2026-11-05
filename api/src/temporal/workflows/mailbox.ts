import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  log,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
  WorkflowIdReusePolicy,
} from "@temporalio/workflow";

import type { Activities } from "../activities";
import { type GmailNotification, processEmailWorkflowId, QUERIES, SIGNALS } from "../names";
import { processEmailWorkflow } from "./process-email";

const acts = proxyActivities<Activities>({
  startToCloseTimeout: "30s",
  retry: { initialInterval: "2s", maximumInterval: "2m" },
});

export const gmailNotification = defineSignal<[GmailNotification]>(SIGNALS.gmailNotification);

export interface MailboxStatus {
  email: string;
  lastHistoryId: string;
  emailsStarted: number;
  lastCheckedAt: string | null;
}
export const statusQuery = defineQuery<MailboxStatus>(QUERIES.status);

export interface MailboxInput {
  email: string;
  lastHistoryId?: string;
  emailsStarted?: number;
  /** A notification that arrived just before continue-as-new. */
  pending?: boolean;
}

/**
 * One long-lived workflow per mailbox (ported from lacey-invoices-claude).
 * Each Gmail notification wakes it: it lists new INBOX messages since the
 * stored history id and starts one processEmail workflow per message.
 * Batches run one at a time, so the history cursor never races.
 */
export async function mailboxWorkflow(input: MailboxInput): Promise<void> {
  const status: MailboxStatus = {
    email: input.email,
    lastHistoryId: input.lastHistoryId ?? "",
    emailsStarted: input.emailsStarted ?? 0,
    lastCheckedAt: null,
  };
  let pending = input.pending ?? false;

  // Register handlers before the first await so early signals/queries land.
  setHandler(gmailNotification, () => {
    pending = true;
  });
  setHandler(statusQuery, () => status);

  if (!status.lastHistoryId) status.lastHistoryId = await acts.getStoredHistoryId(input.email);

  for (;;) {
    await condition(() => pending || workflowInfo().continueAsNewSuggested);
    if (!pending) break; // history is getting long; start fresh below

    pending = false;
    const { messageIds, historyId } = await acts.listNewMessages(input.email, status.lastHistoryId);
    for (const messageId of messageIds) {
      try {
        await startChild(processEmailWorkflow, {
          workflowId: processEmailWorkflowId(input.email, messageId),
          args: [{ account: input.email, messageId }],
          // The same email must never be processed twice, even after it finished.
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          // Each email keeps running even if this workflow continues-as-new.
          parentClosePolicy: ParentClosePolicy.ABANDON,
        });
        status.emailsStarted++;
      } catch (err) {
        if (err instanceof WorkflowExecutionAlreadyStartedError) log.info("Email already processed", { messageId });
        else throw err;
      }
    }
    status.lastHistoryId = historyId;
    status.lastCheckedAt = new Date().toISOString();
    await acts.saveHistoryId(input.email, historyId);
    if (workflowInfo().continueAsNewSuggested) break;
  }

  await continueAsNew<typeof mailboxWorkflow>({
    email: input.email,
    lastHistoryId: status.lastHistoryId,
    emailsStarted: status.emailsStarted,
    pending,
  });
}
