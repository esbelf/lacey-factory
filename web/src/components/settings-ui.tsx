import clsx from "clsx";
import { useId, useState, type ReactNode } from "react";

import { buttonClass } from "./ui";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

/** Title, one line on what the list is for, and the section's main action. */
export function SectionHeader({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line px-4 py-4 sm:px-6">
      <div className="max-w-2xl">
        <h2 className="text-xl font-semibold text-ink">{title}</h2>
        {children && <p className="mt-1 text-sm text-muted">{children}</p>}
      </div>
      {action}
    </div>
  );
}

/** Filter chips (materials, product groups). Each carries its count. */
export function ChipTabs<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { id: T; label: string; count: number; dim?: boolean }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3 sm:px-6">
      {items.map((i) => {
        const selected = i.id === value;
        return (
          <button
            key={i.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(i.id)}
            className={clsx(
              "rounded-md px-3 py-1.5 text-sm font-semibold",
              focusRing,
              selected ? "bg-brand text-white" : "text-muted hover:bg-canvas hover:text-ink",
              i.dim && !selected && "opacity-60",
            )}
          >
            {i.label}
            <span className={clsx("ml-1.5 tabular-nums", selected ? "text-white/70" : "text-muted/80")}>{i.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A list row that reads as facts and opens its form only when asked.
 * `editor` gets `close` so a single-form row can shut itself after saving.
 */
export function EditableRow({
  children,
  editor,
  canEdit = true,
  dim,
  editLabel = "Edit",
  aside,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
  editor: (close: () => void) => ReactNode;
  canEdit?: boolean;
  dim?: boolean;
  editLabel?: string;
  aside?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className={clsx("px-4 py-3 sm:px-6", open && "bg-canvas/60")}>
      <div className="flex items-start gap-4">
        <div className={clsx("min-w-0 flex-1", dim && !open && "opacity-55")}>{children}</div>
        {aside}
        {canEdit && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
            className={clsx(
              "shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold",
              focusRing,
              open ? "bg-surface text-ink ring-1 ring-line" : "text-brand hover:bg-canvas",
            )}
          >
            {open ? "Close" : editLabel}
          </button>
        )}
      </div>
      {open && (
        <div id={id} className="mt-3">
          {editor(() => setOpen(false))}
        </div>
      )}
      {footer}
    </li>
  );
}

/** "Add …" button that unfolds into the add form at the foot of a list. */
export function AddPanel({
  label,
  children,
  inline,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
  /** Inside a row rather than at the foot of the list. */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={inline ? "mt-2" : "border-t border-line px-4 py-4 sm:px-6"}>
      {open ? (
        <div id={id}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-ink">{label}</h3>
            <button type="button" onClick={() => setOpen(false)} className={clsx("rounded-md px-3 py-1.5 text-sm font-semibold text-muted hover:text-ink", focusRing)}>
              Cancel
            </button>
          </div>
          {children(() => setOpen(false))}
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={false}
          aria-controls={id}
          onClick={() => setOpen(true)}
          className={clsx(inline ? "inline-flex items-center gap-1.5 rounded-md py-1 text-sm font-semibold text-brand hover:underline" : buttonClass("secondary"), focusRing)}
        >
          <span aria-hidden className="text-lg leading-none text-accent">+</span>
          {label}
        </button>
      )}
    </div>
  );
}

/** A small "Off" tag for things turned off. */
export function OffTag() {
  return <span className="ml-2 rounded bg-line px-1.5 py-0.5 align-middle text-xs font-semibold text-muted">Off</span>;
}

/**
 * A cut piece drawn to scale: length runs left to right, width top to bottom.
 * All sizes of one material share `scale` (px per foot) so they compare at a glance.
 * Pieces longer than `maxPx` are drawn broken, like a dimension drawing.
 * Sewn sizes get a stitched hem line; the orange edge is where the roll is cut.
 */
export function CutDiagram({
  widthFt,
  lengthFt,
  scale,
  sewn,
  maxPx = 150,
}: {
  widthFt: number;
  lengthFt: number;
  scale: number;
  sewn: boolean;
  maxPx?: number;
}) {
  const full = lengthFt * scale;
  const broken = full > maxPx;
  const w = Math.max(6, Math.min(full, maxPx));
  const h = Math.max(6, widthFt * scale);
  const inset = 3;
  const bx = w * 0.55;
  return (
    <svg width={w + 4} height={h} viewBox={`0 0 ${w + 4} ${h}`} aria-hidden className="block shrink-0 overflow-visible">
      <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={1.5} className="fill-brand/10 stroke-brand/45" />
      {sewn && w > 2 * inset + 4 && h > 2 * inset + 4 && (
        <rect x={inset} y={inset} width={w - 2 * inset} height={h - 2 * inset} rx={1} fill="none" strokeDasharray="3 2" className="stroke-brand/50" />
      )}
      {broken && (
        <g>
          <rect x={bx - 3} y={-1} width={6} height={h + 2} className="fill-surface" />
          <line x1={bx - 5} y1={h + 1} x2={bx - 1} y2={-1} className="stroke-brand/45" />
          <line x1={bx + 1} y1={h + 1} x2={bx + 5} y2={-1} className="stroke-brand/45" />
        </g>
      )}
      <line x1={w + 1.5} y1={0} x2={w + 1.5} y2={h} strokeWidth={2.5} className="stroke-accent" />
    </svg>
  );
}

/** Label + value pair used in product recipes. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm text-ink sm:truncate">{children}</dd>
    </div>
  );
}

export const controlRow = "flex flex-wrap items-end gap-3";
