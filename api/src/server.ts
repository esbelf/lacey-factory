// Local / docker entry point: a plain Node HTTP server on PORT (default 8787).
import { config } from "dotenv";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { emailConfig } from "./config";
import { appDeps } from "./deps";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(appDeps).fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`API listening on http://localhost:${port}`);
});

if (emailConfig().pubsubMode === "pull") {
  const { startPubSubPull } = await import("./pubsub-pull");
  startPubSubPull();
}
