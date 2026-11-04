/**
 * Auth0 Post-Login Action — "Lacey Factory: lakemat.com only".
 * Paste into Auth0 → Actions → Library → Build Custom → Login / Post Login,
 * then add it to the Login flow.
 *
 * Secrets:
 *   FACTORY_CLIENT_ID = client ID of the "Lacey Factory" Single Page Application
 *   ALLOWED_EMAILS    = comma-separated extra emails (floor crew without a
 *                       @lakemat.com account). Keep in sync with the API's
 *                       ALLOWED_EMAILS env var (api/src/lib/access.ts re-checks).
 *
 * It also copies email / email_verified / name into the access token, because
 * the API only sees the access token (claim namespace must match
 * CLAIM_NS in api/src/auth.ts).
 */
exports.onExecutePostLogin = async (event, api) => {
  // Only guard the factory app; other apps in this tenant are untouched.
  if (event.client.client_id !== event.secrets.FACTORY_CLIENT_ID) return;

  const email = (event.user.email || "").trim().toLowerCase();
  const allowlist = (event.secrets.ALLOWED_EMAILS || "")
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const domain = email.slice(email.lastIndexOf("@") + 1);
  const allowed = event.user.email_verified === true && (domain === "lakemat.com" || allowlist.includes(email));

  if (!allowed) {
    api.access.deny("This app is for the LakeMat team only.");
    return;
  }

  const ns = "https://factory.lakemat.com/";
  api.accessToken.setCustomClaim(`${ns}email`, email);
  api.accessToken.setCustomClaim(`${ns}email_verified`, event.user.email_verified === true);
  api.accessToken.setCustomClaim(`${ns}name`, event.user.name || email);
};
