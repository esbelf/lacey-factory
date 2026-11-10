// Startup helpers for the Lambda entry (lambda.ts): secrets and the CloudFront check.
import { timingSafeEqual } from "node:crypto";

async function readSecret(arn: string): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  return res.SecretString ?? "{}";
}

/**
 * Copies the app secret (a JSON object, APP_SECRETS_ARN) into process.env.
 * Empty values are skipped and variables already set are never overwritten.
 */
export async function loadSecrets(arn = process.env.APP_SECRETS_ARN, read = readSecret) {
  if (!arn) return;
  const values = JSON.parse(await read(arn)) as Record<string, unknown>;
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && value.trim() && !process.env[name]?.trim()) process.env[name] = value;
  }
}

/** True when the request came through CloudFront, which adds x-origin-verify. */
export function fromCloudFront(headers: Record<string, string | string[] | undefined> | undefined, secret: string) {
  const value = headers?.["x-origin-verify"];
  const got = Buffer.from(typeof value === "string" ? value : "");
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}
