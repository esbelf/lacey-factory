// The connected mailbox: status, Google OAuth connect/disconnect, Gmail watch.
import { randomBytes } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";

import { emailConfig, MAILBOX_EMAIL } from "../config";
import { emailAccounts, oauthStates } from "../db/schema";
import type { DB } from "../db/types";
import { UserError } from "../domain/errors";
import { GMAIL_SCOPES, GmailApi, oauthClient } from "./gmail";
import { decryptToken, encryptToken } from "./tokens";

export type AccountStatus = "connected" | "needs_reauth" | "disconnected";

export async function getAccount(db: DB, email = MAILBOX_EMAIL) {
  const [row] = await db.select().from(emailAccounts).where(eq(emailAccounts.email, email));
  return row;
}

export async function accountStatus(db: DB) {
  const a = await getAccount(db);
  return {
    email: MAILBOX_EMAIL,
    status: (a?.status ?? "disconnected") as AccountStatus,
    connectedAt: a?.connectedAt ?? null,
    connectedBy: a?.connectedBy ?? null,
    watchExpiresAt: a?.watchExpiresAt ?? null,
    mode: emailConfig().gmailMode,
  };
}

async function upsertAccount(db: DB, values: Partial<typeof emailAccounts.$inferInsert>) {
  await db
    .insert(emailAccounts)
    .values({ email: MAILBOX_EMAIL, ...values })
    .onConflictDoUpdate({ target: emailAccounts.email, set: { ...values, updatedAt: new Date() } });
}

/** The decrypted refresh token, or null if the mailbox isn't usable. */
export async function refreshTokenFor(db: DB, email: string): Promise<string | null> {
  const a = await getAccount(db, email);
  if (!a || a.status !== "connected" || !a.refreshTokenEnc) return null;
  return decryptToken(a.refreshTokenEnc);
}

export async function setAccountStatus(db: DB, email: string, status: AccountStatus) {
  await db.update(emailAccounts).set({ status, updatedAt: new Date() }).where(eq(emailAccounts.email, email));
}

export async function saveWatch(db: DB, email: string, w: { historyId?: string; expiresAt: Date }) {
  await db
    .update(emailAccounts)
    .set({ watchExpiresAt: w.expiresAt, ...(w.historyId ? { historyId: w.historyId } : {}), updatedAt: new Date() })
    .where(eq(emailAccounts.email, email));
}

export async function saveHistoryId(db: DB, email: string, historyId: string) {
  await db.update(emailAccounts).set({ historyId, updatedAt: new Date() }).where(eq(emailAccounts.email, email));
}

/**
 * Start connecting. Returns where to send the browser: Google's consent page,
 * or (fake mode, local dev) straight back to the app, already connected.
 */
export async function startConnect(db: DB, userEmail: string): Promise<string> {
  const c = emailConfig();
  if (c.gmailMode === "fake") {
    await upsertAccount(db, {
      status: "connected",
      historyId: "0",
      connectedBy: userEmail,
      connectedAt: new Date(),
      watchExpiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    return `${c.appBaseUrl}/inbox?email=connected`;
  }
  const state = randomBytes(24).toString("base64url");
  await db.insert(oauthStates).values({ state, userEmail, expiresAt: new Date(Date.now() + 10 * 60_000) });
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state,
    login_hint: MAILBOX_EMAIL,
  });
}

/** Marks a state used and returns who started it. Rejects unknown, used or expired states. */
export async function consumeState(db: DB, state: string): Promise<string> {
  const [row] = await db
    .update(oauthStates)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthStates.state, state), isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, new Date())))
    .returning();
  if (!row) throw new UserError("This connect link expired or was already used. Click Connect Email again.");
  return row.userEmail;
}

/** Google redirected back with a code: store the token and start watching the inbox. */
export async function finishConnect(db: DB, input: { state: string; code: string }) {
  const userEmail = await consumeState(db, input.state);
  const client = oauthClient();
  const { tokens } = await client.getToken(input.code);
  if (!tokens.refresh_token) throw new UserError("Google didn't return a refresh token. Try connecting again.");

  const gmail = new GmailApi(tokens.refresh_token, client);
  const profile = await gmail.profile();
  if (profile.emailAddress.toLowerCase() !== MAILBOX_EMAIL) {
    await client.revokeToken(tokens.refresh_token).catch(() => {});
    throw new UserError(`Signed in as ${profile.emailAddress}. Connect ${MAILBOX_EMAIL} instead.`);
  }

  const topic = emailConfig().pubsubTopic;
  // Most setup mistakes (wrong topic, Gmail not allowed to publish) show up here; the admin needs to see why.
  const watch = topic
    ? await gmail.watch(topic).catch((err: unknown) => {
        throw new UserError(`Signed in, but Gmail couldn't start watching the inbox: ${err instanceof Error ? err.message : err}`);
      })
    : null;
  await upsertAccount(db, {
    refreshTokenEnc: encryptToken(tokens.refresh_token),
    status: "connected",
    historyId: watch?.historyId ?? profile.historyId,
    watchExpiresAt: watch ? new Date(Number(watch.expiration)) : null,
    connectedBy: userEmail,
    connectedAt: new Date(),
  });
}

export async function disconnect(db: DB) {
  const a = await getAccount(db);
  if (a?.refreshTokenEnc && emailConfig().gmailMode === "live") {
    const token = decryptToken(a.refreshTokenEnc);
    await new GmailApi(token).stop().catch(() => {});
    await oauthClient().revokeToken(token).catch(() => {});
  }
  await upsertAccount(db, { status: "disconnected", refreshTokenEnc: null, watchExpiresAt: null });
}
