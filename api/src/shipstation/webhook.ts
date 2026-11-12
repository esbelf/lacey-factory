// Checking ShipStation webhook deliveries. ShipStation signs `${timestamp}.${rawBody}`
// with RSA-SHA256; the public keys are a JWKS picked by key id.
// https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks
import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from "node:crypto";

export const SIGNATURE_HEADERS = {
  keyId: "x-shipengine-rsa-sha256-key-id",
  signature: "x-shipengine-rsa-sha256-signature",
  timestamp: "x-shipengine-timestamp",
} as const;

/** Deliveries older (or newer, for clock skew) than this are refused. */
const MAX_SKEW_MS = 5 * 60_000;
/** Don't refetch the key set more than once a minute for unknown key ids. */
const REFETCH_MS = 60_000;

type Jwk = JsonWebKey & { kid?: string };
const cache = new Map<string, { keys: Map<string, KeyObject>; fetchedAt: number }>();

async function loadKeys(url: string, fetchFn: typeof fetch): Promise<Map<string, KeyObject>> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Couldn't load ShipStation's signing keys (${res.status}).`);
  const { keys = [] } = (await res.json()) as { keys?: Jwk[] };
  const out = new Map<string, KeyObject>();
  for (const k of keys) if (k.kid) out.set(k.kid, createPublicKey({ key: k, format: "jwk" }));
  return out;
}

async function keyFor(kid: string, url: string, fetchFn: typeof fetch, now: number): Promise<KeyObject | null> {
  let entry = cache.get(url);
  if (!entry || (!entry.keys.has(kid) && now - entry.fetchedAt > REFETCH_MS)) {
    entry = { keys: await loadKeys(url, fetchFn), fetchedAt: now };
    cache.set(url, entry);
  }
  return entry.keys.get(kid) ?? null;
}

export type VerifyResult = { ok: true } | { ok: false; status: 400 | 401; error: string };

/** Is this delivery really from ShipStation, and recent? */
export async function verifyShipStationSignature(
  rawBody: string,
  header: (name: string) => string | undefined,
  opts: { jwksUrl: string; fetch?: typeof fetch; now?: number },
): Promise<VerifyResult> {
  const kid = header(SIGNATURE_HEADERS.keyId);
  const signature = header(SIGNATURE_HEADERS.signature);
  const timestamp = header(SIGNATURE_HEADERS.timestamp);
  if (!kid || !signature || !timestamp) return { ok: false, status: 401, error: "Missing signature" };
  const now = opts.now ?? Date.now();
  const sentAt = Date.parse(timestamp);
  if (Number.isNaN(sentAt) || Math.abs(now - sentAt) > MAX_SKEW_MS) return { ok: false, status: 400, error: "Stale or bad timestamp" };
  const key = await keyFor(kid, opts.jwksUrl, opts.fetch ?? fetch, now);
  if (!key) return { ok: false, status: 401, error: "Unknown signing key" };
  const valid = createVerify("RSA-SHA256").update(`${timestamp}.${rawBody}`).verify(key, signature, "base64");
  return valid ? { ok: true } : { ok: false, status: 401, error: "Bad signature" };
}

/** Forget cached keys (tests). */
export function clearSigningKeys() {
  cache.clear();
}

