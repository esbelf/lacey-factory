// Where the worker reads mail from: the Gmail API (live) or a local folder of
// JSON emails written by `npm run simulate` (fake). Ported from
// lacey-invoices-claude/apps/worker/src/mail/{live,fake}.ts.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { ApplicationFailure } from "@temporalio/activity";

import { emailConfig } from "../config";
import type { DB } from "../db/types";
import { getAccount, refreshTokenFor, setAccountStatus } from "./account";
import { type AttachmentRef, documentMimeType, GmailApi, GmailApiError, type ParsedMessage, parseGmailMessage } from "./gmail";

export interface MailSource {
  /** Message ids added to INBOX after sinceHistoryId, plus the newest history id. */
  listNewMessages(email: string, sinceHistoryId: string): Promise<{ messageIds: string[]; historyId: string }>;
  /** null when the email no longer exists (deleted, or a draft that was replaced). */
  getMessage(email: string, messageId: string): Promise<ParsedMessage | null>;
  getAttachment(email: string, messageId: string, ref: AttachmentRef): Promise<Buffer>;
  renewWatch(email: string): Promise<{ historyId: string; expiresAt: string }>;
}

export class LiveMailSource implements MailSource {
  private clients = new Map<string, { token: string; api: GmailApi }>();
  constructor(private db: DB) {}

  private async api(email: string): Promise<GmailApi> {
    const account = await getAccount(this.db, email);
    if (account?.status === "needs_reauth") {
      throw ApplicationFailure.nonRetryable(`${email} must be reconnected`, "NeedsReauth");
    }
    const token = await refreshTokenFor(this.db, email);
    if (!token) throw ApplicationFailure.nonRetryable(`${email} is not connected`, "AccountMissing");
    const cached = this.clients.get(email);
    if (cached?.token === token) return cached.api;
    const api = new GmailApi(token);
    this.clients.set(email, { token, api });
    return api;
  }

  /** A revoked token can't fix itself: flag the account (UI shows Reconnect) and stop retrying. */
  private async guard<T>(email: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GmailApiError && /invalid_grant/i.test(err.message)) {
        await setAccountStatus(this.db, email, "needs_reauth");
        throw ApplicationFailure.nonRetryable(err.message, "NeedsReauth");
      }
      throw err;
    }
  }

  async listNewMessages(email: string, sinceHistoryId: string) {
    const api = await this.api(email);
    return this.guard(email, async () => {
      try {
        return await api.history(sinceHistoryId);
      } catch (err) {
        // Gmail keeps about a week of history. If ours is too old, look at the
        // last 2 days instead; workflow ids stop an email being processed twice.
        if (err instanceof GmailApiError && err.status === 404) {
          const [messageIds, profile] = await Promise.all([api.search("newer_than:2d"), api.profile()]);
          return { messageIds, historyId: profile.historyId };
        }
        throw err;
      }
    });
  }

  async getMessage(email: string, messageId: string) {
    const api = await this.api(email);
    return this.guard(email, async () => {
      try {
        return parseGmailMessage(await api.message(messageId));
      } catch (err) {
        if (err instanceof GmailApiError && err.status === 404) return null;
        throw err;
      }
    });
  }

  async getAttachment(email: string, messageId: string, ref: AttachmentRef) {
    if (ref.inlineData) return Buffer.from(ref.inlineData, "base64url");
    const api = await this.api(email);
    return this.guard(email, () => api.attachment(messageId, ref.attachmentId!));
  }

  async renewWatch(email: string) {
    const topic = emailConfig().pubsubTopic;
    if (!topic) throw ApplicationFailure.nonRetryable("GMAIL_PUBSUB_TOPIC is not set", "Config");
    const api = await this.api(email);
    const r = await this.guard(email, () => api.watch(topic));
    return { historyId: r.historyId, expiresAt: new Date(Number(r.expiration)).toISOString() };
  }
}

/** Fake-mode email, written by scripts/simulate.ts to <FAKE_INBOX_DIR>/<email>/<id>.json. */
export interface FakeEmail {
  id: string;
  historyId: number;
  from: string;
  subject: string;
  receivedAt: string;
  /** Paths relative to FIXTURES_DIR. */
  attachments: { filename: string; path: string }[];
}

export class FakeMailSource implements MailSource {
  constructor(
    private inboxDir: string,
    private fixturesDir: string,
  ) {}

  private dir(email: string) {
    return path.join(this.inboxDir, email.toLowerCase());
  }

  private async all(email: string): Promise<FakeEmail[]> {
    let files: string[];
    try {
      files = await readdir(this.dir(email));
    } catch {
      return [];
    }
    const emails = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => JSON.parse(await readFile(path.join(this.dir(email), f), "utf8")) as FakeEmail),
    );
    return emails.sort((a, b) => a.historyId - b.historyId);
  }

  async listNewMessages(email: string, sinceHistoryId: string) {
    const since = Number(sinceHistoryId) || 0;
    const emails = (await this.all(email)).filter((e) => e.historyId > since);
    return { messageIds: emails.map((e) => e.id), historyId: String(Math.max(since, ...emails.map((e) => e.historyId))) };
  }

  async getMessage(email: string, messageId: string): Promise<ParsedMessage | null> {
    const found = (await this.all(email)).find((e) => e.id === messageId);
    if (!found) return null;
    return {
      id: found.id,
      from: found.from,
      subject: found.subject,
      receivedAt: found.receivedAt,
      attachments: found.attachments.map((a) => ({
        filename: a.filename,
        mimeType: documentMimeType({ filename: a.filename }) ?? "application/octet-stream",
        attachmentId: a.path,
        size: 0,
      })),
    };
  }

  async getAttachment(_email: string, _messageId: string, ref: AttachmentRef) {
    const root = path.resolve(this.fixturesDir);
    const resolved = path.resolve(root, ref.attachmentId ?? "");
    if (!resolved.startsWith(root + path.sep)) {
      throw ApplicationFailure.nonRetryable("Fixture path escapes FIXTURES_DIR", "BadFixture");
    }
    return readFile(resolved);
  }

  async renewWatch() {
    return { historyId: "0", expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
  }
}

export function mailSource(db: DB): MailSource {
  const c = emailConfig();
  return c.gmailMode === "live" ? new LiveMailSource(db) : new FakeMailSource(c.fakeInboxDir, c.fixturesDir);
}
