import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { createContext, type FormEvent, type ReactNode, useContext, useRef, useState } from "react";

import type { Fields, Mutation, MutationResult } from "../api";
import { buttonClass } from "./ui";

export type FormState = { error?: string; ok?: string; at?: number };

const PendingContext = createContext(false);

export function SubmitButton({
  children,
  variant = "primary",
  className,
  disabled,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  className?: string;
  disabled?: boolean;
}) {
  const pending = useContext(PendingContext);
  return (
    <button type="submit" disabled={pending || disabled} className={clsx(buttonClass(variant), className)}>
      {pending ? "Saving…" : children}
    </button>
  );
}

/**
 * Submits the form's fields to the API, shows the error / success message, and
 * refreshes every query on success (the old app revalidated the whole layout).
 */
export function useSubmit(action: Mutation, onSuccess?: (r: MutationResult) => void) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<FormState>({});
  const [pending, setPending] = useState(false);

  async function submit(fields: Fields): Promise<boolean> {
    setPending(true);
    try {
      const r = await action(fields);
      setState({ ok: r.ok, at: Date.now() });
      await queryClient.invalidateQueries();
      onSuccess?.(r);
      return true;
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : "Something went wrong.", at: Date.now() });
      return false;
    } finally {
      setPending(false);
    }
  }
  return { state, pending, submit };
}

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  confirm,
  onSuccess,
}: {
  action: Mutation;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  confirm?: string;
  onSuccess?: (r: MutationResult) => void;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const { state, pending, submit } = useSubmit(action, onSuccess);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    if (confirm && !window.confirm(confirm)) return;
    const form = e.currentTarget;
    const ok = await submit(Object.fromEntries(new FormData(form)));
    if (ok && resetOnSuccess) form.reset();
  }

  return (
    <PendingContext.Provider value={pending}>
      <form ref={ref} onSubmit={onSubmit} className={className}>
        {children}
        <FormMessage state={state} />
      </form>
    </PendingContext.Provider>
  );
}

export { PendingContext };

export function FormMessage({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="mt-2 basis-full text-sm font-medium text-danger">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p role="status" className="mt-2 basis-full text-sm font-medium text-success">
        {state.ok}
      </p>
    );
  }
  return null;
}
