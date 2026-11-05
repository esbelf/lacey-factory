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
