import { formatFeet, subtractFeet, sumFeet } from "@lacey-factory/shared/feet";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { post } from "../api";
import { FormMessage, PendingContext, SubmitButton, useSubmit } from "./action-form";
import { Field, Input } from "./ui";

type Size = { id: string; label: string; cutLengthFt: number; productFamily: string | null };

/** Tap +/− per size; shows how much roll is left before saving. */
export function CutForm({
  rollId,
  sizes,
  remainingFt,
  today,
  canEditSettings,
}: {
  rollId: string;
  sizes: Size[];
  remainingFt: number;
  today: string;
  canEditSettings: boolean;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});
  // Clear the counts after each successful save.
  const { state, pending, submit } = useSubmit(post(`/api/rolls/${rollId}/cuts`), () => setQty({}));

  const lines = sizes.filter((s) => (qty[s.id] ?? 0) > 0).map((s) => ({ cutSizeId: s.id, qty: qty[s.id] }));
  const needed = useMemo(
    () => sumFeet(sizes.map((s) => s.cutLengthFt * (qty[s.id] ?? 0))),
    [sizes, qty],
  );
  const after = subtractFeet(remainingFt, needed);
  const set = (id: string, n: number) => setQty((q) => ({ ...q, [id]: Math.max(0, n) }));

  if (sizes.length === 0) {
    return (
      <p className="text-muted">
        No sizes set up for this material yet.{" "}
        {canEditSettings ? (
          <>
            Add them in <Link className="underline" to="/settings">Settings</Link>.
          </>
        ) : (
          "Ask a regular worker to add them in Settings."
        )}
      </p>
    );
  }

  return (
    <PendingContext.Provider value={pending}>
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending) submit({ ...Object.fromEntries(new FormData(e.currentTarget)), lines });
      }}
    >

      <ul className="flex flex-col gap-2">
        {sizes.map((s) => {
          const n = qty[s.id] ?? 0;
          return (
            <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
              <div>
                <div className="text-lg font-semibold">{s.label}</div>
                <div className="text-sm text-muted">
                  {formatFeet(s.cutLengthFt)} each{s.productFamily ? ` · ${s.productFamily}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" aria-label={`One less ${s.label}`} onClick={() => set(s.id, n - 1)}
                  className="h-12 w-12 rounded-lg border border-line text-2xl font-semibold">−</button>
                <input
                  aria-label={`${s.label} quantity`}
                  inputMode="numeric"
                  className="h-12 w-16 rounded-lg border border-line bg-surface text-center text-xl font-semibold"
                  value={n}
                  onChange={(e) => set(s.id, parseInt(e.target.value || "0", 10) || 0)}
                />
                <button type="button" aria-label={`One more ${s.label}`} onClick={() => set(s.id, n + 1)}
                  className="h-12 w-12 rounded-lg bg-brand text-2xl font-semibold text-white">+</button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Cut on">
          <Input type="date" name="cutOn" defaultValue={today} required />
        </Field>
        <Field label="Notes (optional)">
          <Input name="notes" placeholder="e.g. cut by Chris" />
        </Field>
      </div>

      <div className={`rounded-lg p-3 text-base ${after < 0 ? "bg-danger/10 text-danger" : "bg-canvas"}`}>
        Using <strong>{formatFeet(needed)}</strong> of {formatFeet(remainingFt)} left →{" "}
        <strong>{formatFeet(after)}</strong> after this cut
        {after < 0 && " — not enough roll"}
      </div>

      <div>
        <SubmitButton>Save cut</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
    </PendingContext.Provider>
  );
}
