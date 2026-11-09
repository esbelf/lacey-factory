import type { Permission } from "@lacey-factory/shared/permissions";
import { ROLE_LABEL } from "@lacey-factory/shared/permissions";
import clsx from "clsx";
import { Link, NavLink } from "react-router";

import { DEV_AUTH, DEV_EMAIL_KEY } from "../api";
import { useLogout } from "../auth";
import { useCan, useMe } from "../me";
import { EmailStatus } from "./email-status";

const LINKS: { href: string; label: string; need?: Permission }[] = [
  { href: "/rolls", label: "Rolls" },
  { href: "/cut", label: "To sew" },
  { href: "/summit", label: "Summit" },
  { href: "/inventory", label: "Inventory" },
  { href: "/orders", label: "Orders", need: "orders" },
  { href: "/customers", label: "Customers", need: "orders" },
  { href: "/inbox", label: "Inbox", need: "invoices:review" },
  { href: "/settings", label: "Settings", need: "settings" },
  { href: "/users", label: "Users", need: "users" },
];

export function Nav() {
  const me = useMe();
  const can = useCan();
  const logout = useLogout();

  return (
    <header className="bg-brand text-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link to="/rolls" className="text-lg font-bold">
          LakeMat <span className="text-accent">Factory</span>
        </Link>
        <nav className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
          {LINKS.filter((l) => !l.need || can(l.need)).map((l) => (
            <NavLink
              key={l.href}
              to={l.href}
              className={({ isActive }) =>
                clsx(
                  "rounded-lg px-3 py-2 font-medium whitespace-nowrap",
                  isActive ? "bg-white/15" : "text-white/80 hover:text-white",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm text-white/80">
          <EmailStatus />
          {DEV_AUTH ? (
            <DevUserSwitch email={me?.email} />
          ) : (
            <span className="hidden md:inline">{me?.email}</span>
          )}
          {me && <span className="hidden rounded bg-white/10 px-2 py-0.5 lg:inline">{ROLE_LABEL[me.role]}</span>}
          {logout && (
            <button
              type="button"
              onClick={logout}
              className="rounded-lg border border-white/30 px-3 py-1.5 hover:bg-white/10"
            >
              Log out
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/** Local dev only: act as another email to try out roles. */
function DevUserSwitch({ email }: { email?: string }) {
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const v = String(new FormData(e.currentTarget).get("email") ?? "").trim();
        if (v) localStorage.setItem(DEV_EMAIL_KEY, v);
        else localStorage.removeItem(DEV_EMAIL_KEY);
        window.location.reload();
      }}
    >
      <span className="text-xs uppercase">dev as</span>
      <input
        name="email"
        key={email}
        defaultValue={email}
        className="h-8 w-52 rounded border border-white/30 bg-transparent px-2 text-white"
        title="Local dev: press Enter to act as this email"
      />
    </form>
  );
}
