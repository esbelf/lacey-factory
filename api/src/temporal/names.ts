// Names shared by workflows, the worker and clients. Keep this file free of
// Node imports: workflow code imports it and runs in Temporal's sandbox.

export const WORKFLOWS = {
  mailbox: "mailboxWorkflow",
  processEmail: "processEmailWorkflow",
  renewWatch: "renewWatchWorkflow",
  amazonSync: "amazonSyncWorkflow",
} as const;

export const SIGNALS = { gmailNotification: "gmailNotification" } as const;
export const QUERIES = { status: "status" } as const;

export const RENEW_SCHEDULE_ID = "renew-gmail-watch";
export const AMAZON_SCHEDULE_ID = "amazon-order-sync";
/** "Sync now" from the Orders page; one at a time. */
export const AMAZON_SYNC_NOW_ID = "amazon-sync-now";

export const mailboxWorkflowId = (email: string) => `mailbox-${email.toLowerCase()}`;
export const processEmailWorkflowId = (email: string, messageId: string) => `email-${email.toLowerCase()}-${messageId}`;

export interface GmailNotification {
  emailAddress: string;
  historyId: string;
}
