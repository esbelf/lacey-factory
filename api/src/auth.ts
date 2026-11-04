import { createRemoteJWKSet, jwtVerify } from "jose";

import { isAllowedEmail, parseAllowlist } from "./lib/access";

/** Who is calling, before we look them up in the users table. */
export type Identity = { email: string; name: string | null };

/** Returns the caller, null if not signed in, or "denied" if signed in but not allowed. */
export type Authenticate = (req: Request) => Promise<Identity | null | "denied">;

/** Custom claims added to the access token by auth0/post-login-action.js. */
export const CLAIM_NS = "https://factory.lakemat.com/";

/**
 * Local-only bypass: under NODE_ENV=development with DEV_AUTH_EMAIL set, every
 * request is that user. An `x-dev-email` header switches user, to try out
 * other roles. Never active in Lambda (see lambda.ts).
 */
function devAuthEmail(): string | undefined {
  if (process.env.NODE_ENV !== "development") return undefined;
  return process.env.DEV_AUTH_EMAIL?.trim().toLowerCase() || undefined;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Verifies the Auth0 access token (Authorization: Bearer …). */
export const authenticate: Authenticate = async (req) => {
  const dev = devAuthEmail();
  if (dev) {
    const email = req.headers.get("x-dev-email")?.trim().toLowerCase() || dev;
    return { email, name: `${email} (local dev)` };
  }

  const domain = process.env.AUTH0_DOMAIN;
  const audience = process.env.AUTH0_AUDIENCE;
  if (!domain || !audience) throw new Error("AUTH0_DOMAIN and AUTH0_AUDIENCE are required.");

  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return null;

  jwks ??= createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/`, audience }));
  } catch {
    return null;
  }

  const email = payload[`${CLAIM_NS}email`];
  const verified = payload[`${CLAIM_NS}email_verified`];
  const name = payload[`${CLAIM_NS}name`];
  if (typeof email !== "string") return "denied";
  // Same rule as the Auth0 Action, checked again here.
  if (!isAllowedEmail(email, verified === true, parseAllowlist(process.env.ALLOWED_EMAILS))) return "denied";
  return { email: email.toLowerCase(), name: typeof name === "string" ? name : null };
};
