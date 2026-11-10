export const ALLOWED_DOMAIN = "lakemat.com";

/** Parse the comma/space/newline separated ALLOWED_EMAILS list. */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Who may use the factory app: a verified @lakemat.com email, or a verified
 * email on the allowlist (floor crew without a lakemat.com account).
 * Mirrors the Auth0 Post-Login Action in ../terraform-lacey-factory/auth0/post-login-action.js.
 */
export function isAllowedEmail(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined,
  allowlist: Set<string>,
): boolean {
  if (!email || emailVerified !== true) return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 1) return false;
  return normalized.slice(at + 1) === ALLOWED_DOMAIN || allowlist.has(normalized);
}
