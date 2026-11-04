import type { ReactNode } from "react";

import { useLogout } from "../auth";

export function Splash({ children }: { children: ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center px-4 text-muted">{children}</main>;
}

export function Denied({ message }: { message?: string }) {
  const logout = useLogout();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">No access</h1>
      <p className="text-muted">
        The factory app is only for the LakeMat team. Sign in with your @lakemat.com account, or ask Eric to add your
        email.
      </p>
      {message && <p className="text-sm text-muted">({message})</p>}
      {logout && (
        <button type="button" onClick={logout} className="self-start text-brand underline">
          Sign in with a different account
        </button>
      )}
    </main>
  );
}
