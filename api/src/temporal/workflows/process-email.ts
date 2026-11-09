import { ActivityFailure, log, proxyActivities } from "@temporalio/workflow";

import type { Activities } from "../activities";

const acts = proxyActivities<Activities>({
  startToCloseTimeout: "30s",
  retry: { initialInterval: "2s", maximumInterval: "1m", maximumAttempts: 10 },
});

const archive = proxyActivities<Activities>({
  startToCloseTimeout: "2m",
  retry: { initialInterval: "5s", maximumInterval: "1m", maximumAttempts: 8 },
});

// Each Claude call costs money, so cap the attempts.
const read = proxyActivities<Activities>({
  startToCloseTimeout: "3m",
  retry: { initialInterval: "10s", backoffCoefficient: 2, maximumAttempts: 5 },
});

export type EmailOutcome = "message_gone" | "not_a_supplier" | "no_documents" | "done";

/**
 * One email: is it from a supplier → archive each document to S3 → read it
 * with Claude → hand it to the supplier kind's handler (rolls: register them
 * or flag for review). Every step is idempotent, so retries are safe.
 */
export async function processEmailWorkflow(input: { account: string; messageId: string }): Promise<EmailOutcome> {
  const message = await acts.fetchMessage(input.account, input.messageId);
  // Deleted before we got to it (or a draft Gmail replaced): nothing to do.
  if (!message) return "message_gone";
  const supplier = await acts.matchSupplier(message.from);
  if (!supplier) return "not_a_supplier";
  if (message.attachments.length === 0) {
    log.info("Supplier email has no PDF or image attachments", { messageId: input.messageId, supplier: supplier.name });
    return "no_documents";
  }

  for (const attachment of message.attachments) {
    const doc = await archive.archiveDocument({ account: input.account, message, attachment, supplier });
    if (doc.status !== "processing") continue; // already handled by an earlier run
    try {
      await read.extractDocument(doc.id);
    } catch (err) {
      // Unreadable (refused, bad file): a person takes it from here.
      const why = err instanceof ActivityFailure && err.cause ? err.cause.message : String(err);
      log.warn("Could not read document", { documentId: doc.id, error: why });
      await acts.flagDocument(doc.id, `Couldn't read this document automatically: ${why}`);
      continue;
    }
    await acts.handleDocument(doc.id, supplier.kind);
  }
  return "done";
}
