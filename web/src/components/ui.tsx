import clsx from "clsx";
import { Link } from "react-router";
import type { ComponentProps, ReactNode } from "react";

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-xl border border-line bg-surface p-4 sm:p-5", className)}>
      {title && <h2 className="mb-3 text-lg font-semibold text-ink">{title}</h2>}
      {children}
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-ink">
      {label}
      {children}
      {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
    </label>
  );
}

const control =
  "h-11 rounded-lg border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:outline-brand";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={clsx(control, props.className)} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={clsx(control, props.className)} />;
}

export function ButtonLink({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <Link to={href} className={buttonClass(variant)}>
      {children}
    </Link>
  );
}

export function buttonClass(variant: "primary" | "secondary" | "danger" | "ghost" = "primary") {
  return clsx(
    "inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-base font-semibold whitespace-nowrap disabled:opacity-50",
    variant === "primary" && "bg-brand text-white hover:bg-brand-strong",
    variant === "secondary" && "border border-line bg-surface text-ink hover:bg-canvas",
    variant === "danger" && "border border-danger/40 bg-surface text-danger hover:bg-danger/10",
    variant === "ghost" && "h-9 px-2 text-sm text-muted hover:text-danger",
  );
}

export const STATUS_LABEL = { uncut: "Not cut", partially_cut: "Partly cut", closed: "Closed" } as const;

export function StatusBadge({ status }: { status: keyof typeof STATUS_LABEL }) {
  return (
    <span
      className={clsx(
        "inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold",
        status === "uncut" && "bg-brand/15 text-brand-strong",
        status === "partially_cut" && "bg-warn/20 text-ink",
        status === "closed" && "bg-line text-muted",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full border-collapse text-left text-base [&_td]:border-t [&_td]:border-line [&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:py-2 [&_th]:text-sm [&_th]:font-semibold [&_th]:text-muted">
        {children}
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">{children}</p>;
}

export function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
