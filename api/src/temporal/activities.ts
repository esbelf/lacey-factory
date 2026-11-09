// Activities: everything that touches Gmail, S3, Claude or the database.
// Built from injected clients so tests can swap in fakes.
import { createHash } from "node:crypto";

import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import { eq } from "drizzle-orm";

import type { OrderSource } from "../amazon/order-source";
import { SpApiError } from "../amazon/sp-api";
import { syncBegin, syncEnd, syncPage } from "../amazon/sync";
import { emailAccounts, suppliers } from "../db/schema";
import type { DB } from "../db/types";
import {
  getDocument,
  matchSupplier as findSupplier,
  recordDocument,
  saveExtraction,
  setDocumentStatus,
} from "../domain/invoices";
import { markSyncFailed } from "../domain/orders";
import { ShopifyError } from "../shopify/admin-api";
import type { ShopifySource } from "../shopify/order-source";
import { ingestOrderById, pullBegin, pullEnd, pullPage } from "../shopify/sync";
import { getAccount, saveHistoryId as storeHistoryId, saveWatch } from "../email/account";
import { type AttachmentRef, DOCUMENT_TYPES, type ParsedMessage, senderAddress } from "../email/gmail";
import type { MailSource } from "../email/mail-source";
import { documentKey } from "../storage";
import type { DocumentReader } from "./extract";
import { HANDLERS, type SupplierKind } from "./handlers";

const MAX_BYTES = 25 * 1024 * 1024;

export interface ActivityDeps {
  db: DB;
  mail: MailSource;
  reader: DocumentReader;
  store: {
    put(key: string, body: Buffer, contentType: string): Promise<void>;
    get(key: string): Promise<Buffer>;
  };
  /** Amazon orders; null when AMAZON_MODE=off. */
  orders?: OrderSource | null;
  /** Shopify orders; null when SHOPIFY_MODE=off. */
  shopify?: ShopifySource | null;
}

export type SupplierRef = { id: string; name: string; kind: SupplierKind };

/** Bad keys or a bad request won't fix themselves; throttling and outages will. */
async function shopifyCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ShopifyError && !err.retryable) throw ApplicationFailure.nonRetryable(err.message, "ShopifyError");
    throw err;
  }
}

export function createActivities({ db, mail, reader, store, orders = null, shopify = null }: ActivityDeps) {
  const needShopify = () => {
    if (!shopify) throw ApplicationFailure.nonRetryable("Shopify is off (SHOPIFY_MODE=off).", "ShopifyOff");
    return shopify;
  };
  return {
    async getStoredHistoryId(email: string): Promise<string> {
      return (await getAccount(db, email))?.historyId ?? "0";
    },

    async saveHistoryId(email: string, historyId: string): Promise<void> {
      await storeHistoryId(db, email, historyId);
    },

    async listNewMessages(email: string, sinceHistoryId: string) {
      return mail.listNewMessages(email, sinceHistoryId);
    },

    async fetchMessage(account: string, messageId: string): Promise<ParsedMessage> {
      return mail.getMessage(account, messageId);
    },

    async matchSupplier(from: string): Promise<SupplierRef | null> {
      const s = await findSupplier(db, senderAddress(from));
      return s ? { id: s.id, name: s.name, kind: s.kind } : null;
    },

    /** Download → S3 → record. Content-addressed, so a retry finds the same row. */
    async archiveDocument(input: {
      account: string;
      message: ParsedMessage;
      attachment: AttachmentRef;
      supplier: SupplierRef;
    }): Promise<{ id: string; status: string }> {
      const { account, message, attachment, supplier } = input;
      const ext = DOCUMENT_TYPES[attachment.mimeType];
      if (!ext) throw ApplicationFailure.nonRetryable(`Unsupported file type ${attachment.mimeType}`, "BadFile");
      const body = await mail.getAttachment(account, message.id, attachment);
      if (body.length > MAX_BYTES) throw ApplicationFailure.nonRetryable(`${attachment.filename} is over 25 MB`, "TooLarge");

      const sha256 = createHash("sha256").update(body).digest("hex");
      const key = documentKey({
        supplierName: supplier.name,
        date: message.receivedAt.slice(0, 10),
        reference: message.id,
        sha256,
        ext,
      });
      await store.put(key, body, attachment.mimeType);
      const row = await recordDocument(db, {
        supplierId: supplier.id,
        account,
        gmailMessageId: message.id,
        sha256,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        emailFrom: message.from,
        emailSubject: message.subject,
        emailReceivedAt: new Date(message.receivedAt),
        s3Key: key,
      });
      return { id: row.id, status: row.status };
    },

    async extractDocument(documentId: string): Promise<void> {
      const doc = await getDocument(db, documentId);
      if (!doc) throw ApplicationFailure.nonRetryable(`Document ${documentId} not found`, "NotFound");
      if (doc.extracted) return; // already read on an earlier attempt
      const [supplier] = await db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, doc.supplierId));
      const supplierName = supplier?.name ?? doc.emailFrom;
      const extraction = await reader.read(await store.get(doc.s3Key), doc.mimeType, { supplierName });
      await saveExtraction(db, documentId, extraction);
    },

    async flagDocument(documentId: string, reason: string): Promise<void> {
      await setDocumentStatus(db, documentId, "needs_review", reason);
    },

    async handleDocument(documentId: string, kind: SupplierKind) {
      return HANDLERS[kind](db, documentId);
    },

    async listConnectedAccounts(): Promise<string[]> {
      const rows = await db.select().from(emailAccounts).where(eq(emailAccounts.status, "connected"));
      return rows.map((r) => r.email);
    },

    async renewWatch(email: string): Promise<void> {
      const w = await mail.renewWatch(email);
      await saveWatch(db, email, { expiresAt: new Date(w.expiresAt) });
    },

    // ── Amazon orders ──

    async amazonSyncBegin(): Promise<string> {
      return syncBegin(db);
    },

    async amazonSyncPage(since: string, nextToken: string | null) {
      if (!orders) throw ApplicationFailure.nonRetryable("Amazon is off (AMAZON_MODE=off).", "AmazonOff");
      heartbeat();
      try {
        return await syncPage(db, orders, since, nextToken);
      } catch (err) {
        // Bad keys or a bad request won't fix themselves; rate limits and outages will.
        if (err instanceof SpApiError && !err.retryable) throw ApplicationFailure.nonRetryable(err.message, "AmazonError");
        throw err;
      }
    },

    async amazonSyncEnd(maxUpdated: string | null, count: number): Promise<void> {
      await syncEnd(db, maxUpdated, count);
    },

    async amazonSyncFailed(message: string): Promise<void> {
      await markSyncFailed(db, "amazon", message.slice(0, 1000));
    },

    // ── Shopify orders ──

    async shopifyIngestOrder(orderGid: string) {
      const source = needShopify();
      return shopifyCall(() => ingestOrderById(db, source, orderGid));
    },

    async shopifyPullBegin(since: string | null): Promise<string> {
      return pullBegin(db, since);
    },

    async shopifyPullPage(since: string, cursor: string | null) {
      const source = needShopify();
      heartbeat();
      return shopifyCall(() => pullPage(db, source, since, cursor));
    },

    async shopifyPullEnd(maxUpdated: string | null, saved: number): Promise<void> {
      await pullEnd(db, maxUpdated, saved);
    },

    async shopifyFailed(message: string): Promise<void> {
      await markSyncFailed(db, "shopify", message.slice(0, 1000));
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
