// AWS Lambda entry point (Function URL behind CloudFront at /api/*).
// Bundled by build.mjs into dist/lambda.mjs.
import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";

import { createApp } from "./app";
import { appDeps } from "./deps";
import { fromCloudFront, loadSecrets } from "./lambda-env";

if (process.env.DEV_AUTH_EMAIL) {
  throw new Error("DEV_AUTH_EMAIL must never be set in Lambda.");
}
const originSecret = process.env.ORIGIN_VERIFY_SECRET;
if (!originSecret) throw new Error("ORIGIN_VERIFY_SECRET is required in Lambda.");

// Secret settings (DATABASE_URL, API keys…) come from Secrets Manager, once per cold start.
await loadSecrets();

const app = handle(createApp(appDeps));

export const handler = async (event: LambdaEvent, context?: LambdaContext) => {
  // The function URL is public; only CloudFront knows the header.
  if (!fromCloudFront(event.headers, originSecret)) {
    return { statusCode: 403, headers: { "content-type": "application/json" }, body: '{"error":"Forbidden"}' };
  }
  return app(event, context);
};
