// Mailbox connection, OAuth state, token encryption, webhook and inbox routes.
import { randomBytes } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { consumeState } from "../src/email/account";
import { decryptToken, encryptToken } from "../src/email/tokens";
import type { GmailNotification } from "../src/temporal/names";

let db: DB;
let app: ReturnType<typeof createApp>;
const notified: GmailNotification[] = [];
const env = { ...process.env };

async function call(email: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (email) h["x-test-email"] = email;
  const res = await app.request(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

beforeAll(async () => {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "drizzle" });
  db = pg as unknown as DB;
  app = createApp({
    getDb: () => db,
    authenticate: async (req) => {
      const email = req.headers.get("x-test-email");
      return email ? { email, name: null } : null;
    },
    notifyMailbox: async (n) => {
      notified.push(n);
    },
    verifyPushToken: async (token) => token === "good-google-token",
    documentUrl: async (key) => `https://files.test/${key}`,
    startAmazonSync: async () => "started",
    notifyShopifyOrder: async () => {},
    startShopifyPull: async () => "started",
  });
});

afterEach(() => {
  process.env = { ...env };
});

describe("token encryption", () => {
  it("round-trips and fails with the wrong key", () => {
    process.env.EMAIL_TOKEN_KEY = randomBytes(32).toString("base64");
    const stored = encryptToken("1//refresh-token");
    expect(stored).not.toContain("refresh-token");
    expect(decryptToken(stored)).toBe("1//refresh-token");
    process.env.EMAIL_TOKEN_KEY = randomBytes(32).toString("base64");
    expect(() => decryptToken(stored)).toThrow();
  });

  it("requires a 32-byte key", () => {
    process.env.EMAIL_TOKEN_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
  });
});

describe("OAuth state", () => {
  it("can be used once and expires", async () => {
    await db.insert(schema.oauthStates).values([
      { state: "fresh", userEmail: "eric@lakemat.com", expiresAt: new Date(Date.now() + 60_000) },
      { state: "old", userEmail: "eric@lakemat.com", expiresAt: new Date(Date.now() - 1000) },
    ]);
    expect(await consumeState(db, "fresh")).toBe("eric@lakemat.com");
    await expect(consumeState(db, "fresh")).rejects.toThrow(/expired or was already used/);
    await expect(consumeState(db, "old")).rejects.toThrow(/expired/);
    await expect(consumeState(db, "made-up")).rejects.toThrow();
  });

  it("callback with a bad state redirects back with an error", async () => {
    process.env.GMAIL_MODE = "live";
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const res = await call(null, "GET", "/api/email/callback?state=nope&code=abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/inbox\?email=error&message=.*expired/);
  });
});

describe("email routes", () => {
  it("only the admin can see or connect the mailbox", async () => {
    await call("crew@lakemat.com", "GET", "/api/me");
    await call("boss@lakemat.com", "GET", "/api/me");
    const boss = (await call("eric@lakemat.com", "GET", "/api/users")).json as unknown as { id: string; email: string }[];
    const regular = boss.find((u) => u.email === "boss@lakemat.com")!;
    await call("eric@lakemat.com", "PATCH", `/api/users/${regular.id}`, { role: "regular" });

    expect((await call("crew@lakemat.com", "GET", "/api/email/status")).status).toBe(403);
    expect((await call("boss@lakemat.com", "POST", "/api/email/connect")).status).toBe(403);
    const status = await call("eric@lakemat.com", "GET", "/api/email/status");
    expect(status.json).toMatchObject({ email: "eric@lakemat.com", status: "disconnected" });
  });

  it("connects straight away in fake mode (local dev)", async () => {
    process.env.GMAIL_MODE = "fake";
    const res = await call("eric@lakemat.com", "POST", "/api/email/connect");
    expect(res.json.url).toMatch(/\/inbox\?email=connected$/);
    expect((await call("eric@lakemat.com", "GET", "/api/email/status")).json.status).toBe("connected");
  });

  it("builds a Google consent URL with a one-time state in live mode", async () => {
    process.env.GMAIL_MODE = "live";
    process.env.GOOGLE_CLIENT_ID = "client-123";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const res = await call("eric@lakemat.com", "POST", "/api/email/connect");
    const url = new URL(String(res.json.url));
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("login_hint")).toBe("eric@lakemat.com");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("inbox is for regular workers and admin, not factory workers", async () => {
    expect((await call("crew@lakemat.com", "GET", "/api/documents")).status).toBe(403);
    expect((await call("boss@lakemat.com", "GET", "/api/documents")).status).toBe(200);
  });
});

describe("Gmail push webhook", () => {
  const push = (token: string, data: object) =>
    call(null, "POST", "/api/webhooks/gmail", { message: { data: Buffer.from(JSON.stringify(data)).toString("base64") } }, { authorization: `Bearer ${token}` });

  it("is off unless PUBSUB_MODE=push", async () => {
    expect((await push("good-google-token", { emailAddress: "eric@lakemat.com", historyId: 5 })).status).toBe(404);
  });

  it("rejects pushes without a valid Google token", async () => {
    process.env.PUBSUB_MODE = "push";
    expect((await push("forged", { emailAddress: "eric@lakemat.com", historyId: 5 })).status).toBe(401);
    expect(notified).toHaveLength(0);
  });

  it("wakes the mailbox workflow for the connected mailbox only", async () => {
    process.env.PUBSUB_MODE = "push";
    expect((await push("good-google-token", { emailAddress: "Eric@LakeMat.com", historyId: 42 })).status).toBe(204);
    expect((await push("good-google-token", { emailAddress: "stranger@lakemat.com", historyId: 1 })).status).toBe(204);
    expect(notified).toEqual([{ emailAddress: "eric@lakemat.com", historyId: "42" }]);
  });
});
