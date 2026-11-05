import clsx from "clsx";
import { useState } from "react";
import { Link } from "react-router";

import { post, useApi } from "../api";
import { useCan } from "../me";

/**
 * Admin only: shows whether eric@lakemat.com is connected, and a Connect Email
 * button when it isn't. Connecting sends the browser to Google's consent page.
 */
export function EmailStatus() {
  const can = useCan();
  const { data } = useApi("emailStatus", { enabled: can("email:connect"), staleTime: 60_000 });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!can("email:connect") || !data) return null;

  if (data.status === "connected") {
    return (
      <Link
        to="/inbox"
        title={`Reading supplier emails sent to ${data.email}`}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-white/90 hover:bg-white/10"
      >
        <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
        Email connected
      </Link>
    );
  }

  async function connect() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await post("/api/email/connect")({});
      if (r.url) window.location.assign(r.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start connecting.");
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        title={error ?? `Let the app read supplier emails sent to ${data.email}`}
        className={clsx(
          "flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-60",
          data.status === "needs_reauth" ? "bg-warn text-ink" : "bg-accent text-white hover:opacity-90",
        )}
      >
        <span className={clsx("h-2 w-2 rounded-full", data.status === "needs_reauth" ? "bg-danger" : "bg-white/70")} aria-hidden />
        {busy ? "Opening Google…" : data.status === "needs_reauth" ? "Reconnect email" : "Connect Email"}
      </button>
      {error && <span className="text-xs text-white">{error}</span>}
    </span>
  );
}
