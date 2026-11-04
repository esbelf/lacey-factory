import { config } from "dotenv";

// drizzle-kit runs from api/; the single .env lives at the repo root.
config({ path: "../.env", quiet: true });

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Only `db:studio` needs this; `db:generate` works without it.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
