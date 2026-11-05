// Typed client for the Hono API. Reads use the route types exported by the
// API (hono/client); writes post plain form fields and get back { ok } or an
// error message.
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { hc, type InferResponseType } from "hono/client";

import type { AppType } from "../../api/src/app";

export const DEV_AUTH = import.meta.env.VITE_DEV_AUTH === "true";
export const DEV_EMAIL_KEY = "devEmail";

let getToken: () => Promise<string | null | undefined> = async () => null;

/** Called by the auth layer once Auth0 is ready. */
export function setTokenGetter(fn: () => Promise<string | null | undefined>) {
  getToken = fn;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = await getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (DEV_AUTH) {
    const devEmail = localStorage.getItem(DEV_EMAIL_KEY);
    if (devEmail) headers.set("x-dev-email", devEmail);
  }
  return fetch(input, { ...init, headers });
}

const client = hc<AppType>(window.location.origin, { fetch: authFetch }).api;

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status}).`);
  return body as T;
}

// ── Reads ──
type Data<F extends (...args: never[]) => unknown> = Exclude<InferResponseType<F>, { error: string }>;

const reads = {
  me: () => client.me.$get(),
  materials: () => client.materials.$get(),
  cutSizes: () => client["cut-sizes"].$get(),
  products: () => client.products.$get(),
  rolls: () => client.rolls.$get(),
  pipeline: () => client.pipeline.$get(),
  activity: () => client.activity.$get(),
  adjustments: () => client.adjustments.$get(),
  users: () => client.users.$get(),
  emailStatus: () => client.email.status.$get(),
  documents: () => client.documents.$get(),
  suppliers: () => client.suppliers.$get(),
  steel: () => client.steel.$get(),
  sales: () => client.sales.$get(),
};

export type Me = Data<typeof client.me.$get>;
export type UserRow = Data<typeof client.users.$get>[number];
export type Roll = Data<(typeof client.rolls)[":id"]["$get"]>;
export type SupplierDocument = Data<typeof client.documents.$get>[number];
export type Supplier = Data<typeof client.suppliers.$get>[number];
export type SteelData = Data<typeof client.steel.$get>;
export type Product = Data<typeof client.products.$get>[number];
export type SaleRow = Data<typeof client.sales.$get>[number];

/** Short-lived link to view a stored supplier document. */
export async function documentFileUrl(id: string): Promise<string> {
  const res = await client.documents[":id"].file.$get({ param: { id } });
  return (await unwrap<{ url: string }>(res)).url;
}

type Reads = typeof reads;
type ReadData<K extends keyof Reads> = Exclude<Awaited<ReturnType<Awaited<ReturnType<Reads[K]>>["json"]>>, { error: string }>;

/** useQuery for one of the list endpoints, keyed by name. */
export function useApi<K extends keyof Reads>(
  key: K,
  options?: Omit<UseQueryOptions<ReadData<K>, ApiError>, "queryKey" | "queryFn">,
) {
  return useQuery<ReadData<K>, ApiError>({
    queryKey: [key],
    queryFn: async () => unwrap<ReadData<K>>(await reads[key]()),
    ...options,
  });
}

export function useRoll(id: string) {
  return useQuery<Roll, ApiError>({
    queryKey: ["roll", id],
    queryFn: async () => unwrap<Roll>(await client.rolls[":id"].$get({ param: { id } })),
  });
}

// ── Writes ──
export type Fields = Record<string, unknown>;
export type MutationResult = { ok: string; id?: string; url?: string };
export type Mutation = (fields: Fields) => Promise<MutationResult>;

async function send(method: "POST" | "PATCH", path: string, fields: Fields): Promise<MutationResult> {
  const res = await authFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  return unwrap<MutationResult>(res);
}

export const post =
  (path: string): Mutation =>
  (fields) =>
    send("POST", path, fields);

export const patch =
  (path: string): Mutation =>
  (fields) =>
    send("PATCH", path, fields);
