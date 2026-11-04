// Applies the SQL migrations in ./drizzle to DATABASE_URL.
// Usage: npm run db:migrate -w api   (docker compose runs this on start)
import { config } from "dotenv";

config({ path: new URL("../../../.env", import.meta.url), quiet: true });

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");

const client = new pg.Client({ connectionString: url });
await client.connect();
await migrate(drizzle(client), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
await client.end();
console.log("Migrations applied.");
