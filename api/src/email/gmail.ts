// Thin Gmail REST client for one mailbox, plus MIME parsing.
// Ported from lacey-invoices-claude/packages/shared/src/{gmail,message}.ts.
import { OAuth2Client } from "google-auth-library";

import { emailConfig } from "../config";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"];

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export function oauthClient(): OAuth2Client {
  const c = emailConfig();
  if (!c.googleClientId || !c.googleClientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set to use Gmail.");
  }
  return new OAuth2Client({
    clientId: c.googleClientId,
    clientSecret: c.googleClientSecret,
    redirectUri: c.googleRedirectUri,
  });
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  payload: GmailPart;
}

/** Retries are left to the caller (Temporal). */
export class GmailApi {
  private client: OAuth2Client;
  constructor(refreshToken: string, client = oauthClient()) {
    client.setCredentials({ refresh_token: refreshToken });
    this.client = client;
  }

  private async call<T>(
    path: string,
    init: { method?: "GET" | "POST"; data?: unknown; params?: Record<string, unknown> } = {},
  ): Promise<T> {
    try {
      const res = await this.client.request<T>({
        url: `${BASE}${path}`,
        method: init.method ?? "GET",
        data: init.data,
        params: init.params,
        retry: false,
      });
      return res.data;
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: { message?: string } | string } }; status?: number; message?: string };
      const status = e.response?.status ?? e.status;
      const data = e.response?.data?.error;
      const message = (typeof data === "string" ? data : data?.message) ?? e.message ?? String(err);
      throw new GmailApiError(`Gmail ${path}: ${message}`, status);
    }
  }

  profile() {
    return this.call<{ emailAddress: string; historyId: string }>("/profile");
  }

  watch(topicName: string) {
    return this.call<{ historyId: string; expiration: string }>("/watch", {
      method: "POST",
      data: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
    });
  }

  stop() {
    return this.call<unknown>("/stop", { method: "POST" });
  }

  /** New INBOX messages since startHistoryId, following all pages. */
  async history(startHistoryId: string): Promise<{ messageIds: string[]; historyId: string }> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = startHistoryId;
    do {
      const page = await this.call<{
        history?: { messagesAdded?: { message: { id: string } }[] }[];
        historyId: string;
        nextPageToken?: string;
      }>("/history", { params: { startHistoryId, historyTypes: "messageAdded", labelId: "INBOX", pageToken } });
      for (const h of page.history ?? []) for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
      latest = page.historyId ?? latest;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { messageIds: [...ids], historyId: latest };
  }

  async search(q: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.call<{ messages?: { id: string }[]; nextPageToken?: string }>("/messages", {
        params: { q, labelIds: "INBOX", maxResults: 100, pageToken },
      });
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return ids;
  }

  message(id: string) {
    return this.call<GmailMessage>(`/messages/${id}`, { params: { format: "full" } });
  }

  async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const r = await this.call<{ data: string }>(`/messages/${messageId}/attachments/${attachmentId}`);
    return Buffer.from(r.data, "base64url");
  }
}

// ── Parsed messages ──

export interface AttachmentRef {
  filename: string;
  mimeType: string;
  /** Gmail attachment id, or a fixture path in fake mode. */
  attachmentId?: string;
  /** Small attachments come inline as base64url. */
  inlineData?: string;
  size: number;
}

export interface ParsedMessage {
  id: string;
  from: string;
  subject: string;
  /** ISO timestamp of when Gmail received the message. */
  receivedAt: string;
  attachments: AttachmentRef[];
}

/** Documents we can read: PDFs and photos of paper invoices. */
export const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function documentMimeType(p: { mimeType?: string; filename?: string }): string | undefined {
  if (p.mimeType && DOCUMENT_TYPES[p.mimeType]) return p.mimeType;
  const name = p.filename?.toLowerCase() ?? "";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  return undefined;
}

function flatten(part: GmailPart): GmailPart[] {
  return [part, ...(part.parts ?? []).flatMap(flatten)];
}

export function parseGmailMessage(msg: GmailMessage): ParsedMessage {
  const header = (name: string) =>
    msg.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const attachments = flatten(msg.payload)
    .filter((p) => p.filename && documentMimeType(p) && (p.body?.attachmentId || p.body?.data))
    .map((p) => ({
      filename: p.filename!,
      mimeType: documentMimeType(p)!,
      attachmentId: p.body?.attachmentId,
      inlineData: p.body?.attachmentId ? undefined : p.body?.data,
      size: p.body?.size ?? 0,
    }));
  const received = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(header("Date"));
  return {
    id: msg.id,
    from: header("From"),
    subject: header("Subject"),
    receivedAt: Number.isNaN(received.getTime()) ? new Date(0).toISOString() : received.toISOString(),
    attachments,
  };
}

/** "Hanes Billing <billing@hanes.com>" → "billing@hanes.com". */
export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}
