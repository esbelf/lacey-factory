import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema";
import type { DB } from "./types";

let cached: DB | undefined;

/**
 * One pool per process. Locally DATABASE_URL points at the docker-compose
 * Postgres; in production it is Neon's pooled connection string. Lambda runs
 * one request at a time per instance, so a small pool is enough.
 */
export function getDb(): DB {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to connect to the database.");
  const pool = new pg.Pool({
    connectionString: url,
    max: process.env.AWS_LAMBDA_FUNCTION_NAME ? 2 : 10,
  });
  cached = drizzle(pool, { schema }) as unknown as DB;
  return cached;
}

export { schema };
