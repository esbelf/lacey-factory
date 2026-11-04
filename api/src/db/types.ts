import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type * as schema from "./schema";

/** Any Postgres Drizzle database (Neon in prod, PGlite in tests). */
export type DB = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** A transaction handle — same query API as DB. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
