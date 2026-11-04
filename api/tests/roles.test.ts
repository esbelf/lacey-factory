// Users and role permissions, through the real Hono app on PGlite.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";

let db: DB;
let app: ReturnType<typeof createApp>;

/** Tests sign in by sending x-test-email; "denied@x.com" is not allowed. */
async function call(email: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (email) headers["x-test-email"] = email;
  const res = await app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: string } };
}

beforeAll(async () => {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "drizzle" });
  db = pg as unknown as DB;
  app = createApp({
    getDb: () => db,
    authenticate: async (req) => {
      const email = req.headers.get("x-test-email");
      if (!email) return null;
      if (email === "denied@x.com") return "denied";
      return { email, name: null };
    },
  });
});

describe("users and roles", () => {
  it("requires sign-in and rejects people outside the team", async () => {
    expect((await call(null, "GET", "/api/me")).status).toBe(401);
    expect((await call("denied@x.com", "GET", "/api/me")).status).toBe(403);
    expect((await call(null, "GET", "/api/health")).status).toBe(200);
  });

  it("creates new users as factory workers and eric@lakemat.com as admin", async () => {
    const crew = await call("Chris@LakeMat.com", "GET", "/api/me");
    expect(crew.json).toMatchObject({ email: "chris@lakemat.com", role: "factory" });
    expect(crew.json.permissions).toEqual(["floor"]);

    const admin = await call("eric@lakemat.com", "GET", "/api/me");
    expect(admin.json.role).toBe("admin");
  });

  it("lets factory workers do floor work but not settings, undo or adjustments", async () => {
    const mat = await call("eric@lakemat.com", "POST", "/api/materials", { name: "Fabric", requiresSewing: "on" });
    expect(mat.status).toBe(200);
    const [material] = (await call("eric@lakemat.com", "GET", "/api/materials")).json as unknown as { id: string }[];

    expect((await call("chris@lakemat.com", "POST", "/api/materials", { name: "Nope" })).status).toBe(403);
    const roll = await call("chris@lakemat.com", "POST", "/api/rolls", {
      materialId: material.id,
      widthFt: "12.5",
      lengthFt: "360",
      receivedOn: "2026-11-01",
    });
    expect(roll.status).toBe(200);
    expect((await call("chris@lakemat.com", "POST", `/api/rolls/${roll.json.id}/close`, { closedOn: "2026-11-02" })).status).toBe(403);
    expect((await call("chris@lakemat.com", "GET", "/api/users")).status).toBe(403);
  });

  it("lets the admin promote a factory worker to regular", async () => {
    const list = (await call("eric@lakemat.com", "GET", "/api/users")).json as unknown as { id: string; email: string }[];
    const chris = list.find((u) => u.email === "chris@lakemat.com")!;

    const res = await call("eric@lakemat.com", "PATCH", `/api/users/${chris.id}`, { role: "regular" });
    expect(res.status).toBe(200);
    const me = await call("chris@lakemat.com", "GET", "/api/me");
    expect(me.json.role).toBe("regular");
    expect(me.json.permissions).toContain("settings");
    expect((await call("chris@lakemat.com", "POST", "/api/materials", { name: "Geogrid" })).status).toBe(200);
  });

  it("never lets anyone make an admin or change the admin", async () => {
    const list = (await call("eric@lakemat.com", "GET", "/api/users")).json as unknown as { id: string; email: string }[];
    const eric = list.find((u) => u.email === "eric@lakemat.com")!;
    const chris = list.find((u) => u.email === "chris@lakemat.com")!;

    expect((await call("eric@lakemat.com", "PATCH", `/api/users/${chris.id}`, { role: "admin" })).status).toBe(400);
    const demote = await call("eric@lakemat.com", "PATCH", `/api/users/${eric.id}`, { role: "factory" });
    expect(demote.status).toBe(400);
    expect(demote.json.error).toMatch(/admin/);
    // A regular worker can't manage users either.
    expect((await call("chris@lakemat.com", "PATCH", `/api/users/${chris.id}`, { role: "regular" })).status).toBe(403);
  });

  it("returns 404 for a malformed id", async () => {
    expect((await call("eric@lakemat.com", "GET", "/api/rolls/not-a-uuid")).status).toBe(404);
  });
});
