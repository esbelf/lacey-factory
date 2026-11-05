// AWS Lambda entry point (Function URL behind CloudFront at /api/*).
// Bundled by build.mjs into dist/lambda.mjs.
import { handle } from "hono/aws-lambda";

import { createApp } from "./app";
import { appDeps } from "./deps";

if (process.env.DEV_AUTH_EMAIL) {
  throw new Error("DEV_AUTH_EMAIL must never be set in Lambda.");
}

export const handler = handle(createApp(appDeps));
