import { ADMIN_EMAIL, type AssignableRole, type Role } from "@lacey-factory/shared/permissions";
import { asc, eq } from "drizzle-orm";

import { users } from "../db/schema";
import type { DB } from "../db/types";
import { UserError } from "./errors";

export type AppUser = { id: string; email: string; name: string; role: Role };

const SEEN_EVERY_MS = 60 * 60 * 1000;

/**
 * Find or create the signed-in user. New users always start as factory
 * workers; ADMIN_EMAIL is always admin. Refreshes last-seen at most hourly.
 */
export async function ensureUser(db: DB, input: { email: string; name?: string | null }): Promise<AppUser> {
  const email = input.email.trim().toLowerCase();
  const name = input.name?.trim() || email;
  const isAdmin = email === ADMIN_EMAIL;

  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    const fixRole = isAdmin && existing.role !== "admin";
    if (fixRole || Date.now() - existing.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      await db
        .update(users)
        .set({ lastSeenAt: new Date(), ...(fixRole ? { role: "admin" as const } : {}) })
        .where(eq(users.id, existing.id));
    }
    return { id: existing.id, email, name: existing.name, role: isAdmin ? "admin" : existing.role };
  }

  const [row] = await db
    .insert(users)
    .values({ email, name, role: isAdmin ? "admin" : "factory" })
    .onConflictDoUpdate({ target: users.email, set: { lastSeenAt: new Date() } })
    .returning();
  return { id: row.id, email, name: row.name, role: row.role };
}

export async function listUsers(db: DB) {
  return db.select().from(users).orderBy(asc(users.email));
}

export async function setUserRole(db: DB, actor: string, userId: string, role: AssignableRole) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new UserError("That user doesn't exist.");
  if (user.role === "admin" || user.email === ADMIN_EMAIL) throw new UserError("The admin's role can't be changed.");
  await db
    .update(users)
    .set({ role, roleChangedBy: actor, roleChangedAt: new Date() })
    .where(eq(users.id, userId));
  return { ...user, role };
}
