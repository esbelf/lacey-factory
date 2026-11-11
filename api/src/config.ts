// Settings for the supplier-email pipeline, read from the environment on use
// (so tests can change process.env). See .env.example for what each one means.

const env = (name: string) => process.env[name]?.trim() || undefined;

export const MAILBOX_EMAIL = "eric@lakemat.com";

export function emailConfig() {
  return {
    /** "fake" reads JSON emails from FAKE_INBOX_DIR (local dev); "live" calls Gmail. */
    gmailMode: (env("GMAIL_MODE") ?? "fake") as "fake" | "live",
    fakeInboxDir: env("FAKE_INBOX_DIR") ?? "tmp/fake-inbox",
    fixturesDir: env("FIXTURES_DIR") ?? "fixtures",
    googleClientId: env("GOOGLE_CLIENT_ID"),
    googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
    googleRedirectUri: env("GOOGLE_REDIRECT_URI") ?? "http://localhost:8787/api/email/callback",
    /** Where the browser lands after connecting (the web app). */
    appBaseUrl: env("APP_BASE_URL") ?? "http://localhost:5173",
    pubsubTopic: env("GMAIL_PUBSUB_TOPIC"),
    pubsubMode: (env("PUBSUB_MODE") ?? "off") as "off" | "pull" | "push",
    pubsubSubscription: env("GMAIL_PUBSUB_SUBSCRIPTION"),
    pubsubPushAudience: env("PUBSUB_PUSH_AUDIENCE"),
    /** 32-byte key, base64. Encrypts stored Google refresh tokens. */
    tokenKey: env("EMAIL_TOKEN_KEY"),
  };
}

export function temporalConfig() {
  return {
    address: env("TEMPORAL_ADDRESS") ?? "localhost:7233",
    namespace: env("TEMPORAL_NAMESPACE") ?? "default",
    apiKey: env("TEMPORAL_API_KEY"),
    taskQueue: env("TEMPORAL_TASK_QUEUE") ?? "lacey-factory",
  };
}

export function storageConfig() {
  return {
    bucket: env("DOCUMENTS_BUCKET") ?? "lacey-factory-documents-local",
    region: env("AWS_REGION") ?? "us-east-2",
    /** Local S3 (LocalStack in docker compose); unset in AWS. */
    endpoint: env("AWS_ENDPOINT_URL"),
    /** Endpoint the browser can reach for signed links, if different (local docker). */
    publicEndpoint: env("AWS_PUBLIC_ENDPOINT_URL"),
  };
}

export function claudeConfig() {
  return { model: env("CLAUDE_MODEL") ?? "claude-opus-5-5" };
}

export type AmazonMode = "off" | "fake" | "sandbox" | "live";

export function amazonConfig() {
  return {
    /** off: no polling. fake: JSON orders in AMAZON_FAKE_DIR. sandbox/live: SP-API. */
    mode: (env("AMAZON_MODE") ?? "off") as AmazonMode,
    clientId: env("AMAZON_LWA_CLIENT_ID"),
    clientSecret: env("AMAZON_LWA_CLIENT_SECRET"),
    refreshToken: env("AMAZON_REFRESH_TOKEN"),
    /** US and Canada by default. */
    marketplaceIds: (env("AMAZON_MARKETPLACE_IDS") ?? "ATVPDKIKX0DER,A2EUQ1WTGCTBG2").split(",").map((s) => s.trim()).filter(Boolean),
    /** First sync starts here (ISO date); default 30 days back. */
    syncStart: env("AMAZON_SYNC_START"),
    /** How often the schedule polls, e.g. 15m. */
    syncEvery: env("AMAZON_SYNC_EVERY") ?? "15m",
    fakeDir: env("AMAZON_FAKE_DIR") ?? "tmp/fake-amazon",
  };
}

export type ShopifyMode = "off" | "fake" | "live";

export function shopifyConfig() {
  return {
    /** off: webhooks rejected, no pulls. fake: JSON orders in SHOPIFY_FAKE_DIR. live: Admin API. */
    mode: (env("SHOPIFY_MODE") ?? "off") as ShopifyMode,
    /** The US store (also sells to Canada). */
    shop: env("SHOPIFY_SHOP") ?? "lakemat-2.myshopify.com",
    clientId: env("SHOPIFY_CLIENT_ID"),
    /** Also the key Shopify signs webhooks with. */
    clientSecret: env("SHOPIFY_CLIENT_SECRET"),
    apiVersion: env("SHOPIFY_API_VERSION") ?? "2026-01",
    /** Where Shopify sends order webhooks; the worker subscribes this URL. */
    webhookUrl: env("SHOPIFY_WEBHOOK_URL"),
    /** "Pull orders" with no date starts here the first time (default 30 days back). */
    pullStart: env("SHOPIFY_PULL_START"),
    fakeDir: env("SHOPIFY_FAKE_DIR") ?? "tmp/fake-shopify",
  };
}

export function slackConfig() {
  return {
    /** Slack Incoming Webhook for low-stock alerts. Unset (local dev): alerts are only logged. */
    webhookUrl: env("SLACK_WEBHOOK_URL"),
    appBaseUrl: env("APP_BASE_URL") ?? "http://localhost:5173",
  };
}
