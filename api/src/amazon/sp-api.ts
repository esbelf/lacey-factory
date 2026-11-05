// Minimal Selling Partner API client: Login with Amazon token exchange plus the
// two Orders calls we use. No AWS signing is needed since 2023.
import type { AmazonOrder, AmazonOrderItem } from "./types";

export const SP_API_HOSTS = {
  sandbox: "https://sandbox.sellingpartnerapi-na.amazon.com",
  live: "https://sellingpartnerapi-na.amazon.com",
} as const;

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";

export class SpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 429 and 5xx: try again later. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SpApiError";
  }
}

export type SpApiOptions = {
  mode: keyof typeof SP_API_HOSTS;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export type OrdersPage = { orders: AmazonOrder[]; nextToken: string | null };

export class SpApi {
  private token: { value: string; expiresAt: number } | null = null;
  private fetch: typeof fetch;
  private now: () => number;

  constructor(private opts: SpApiOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get host() {
    return SP_API_HOSTS[this.opts.mode];
  }

  /** Access tokens last an hour; refresh a minute early. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.opts.refreshToken,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new SpApiError(
        `Amazon login failed: ${body.error_description ?? body.error ?? res.status}. Check AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET and AMAZON_REFRESH_TOKEN.`,
        res.status,
        res.status >= 500,
      );
    }
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = `${this.host}${path}?${new URLSearchParams(query)}`;
    const res = await this.fetch(url, { headers: { "x-amz-access-token": await this.accessToken(), accept: "application/json" } });
    const body = (await res.json().catch(() => ({}))) as { payload?: T; errors?: { code?: string; message?: string }[] };
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) this.token = null;
      const e = body.errors?.[0];
      throw new SpApiError(
        `Amazon ${path} failed (${res.status}): ${e?.message ?? e?.code ?? "no details"}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    return body.payload as T;
  }

  /**
   * Orders updated after a time, 100 per page. The static sandbox only answers
   * its canned test case, so sandbox mode asks for that instead.
   */
  async getOrders(input: { marketplaceIds: string[]; lastUpdatedAfter: string; nextToken?: string | null }): Promise<OrdersPage> {
    const query: Record<string, string> = { MarketplaceIds: input.marketplaceIds.join(",") };
    if (input.nextToken) query.NextToken = input.nextToken;
    else if (this.opts.mode === "sandbox") query.CreatedAfter = "TEST_CASE_200";
    else {
      query.LastUpdatedAfter = input.lastUpdatedAfter;
      query.MaxResultsPerPage = "100";
    }
    const p = await this.get<{ Orders?: AmazonOrder[]; NextToken?: string }>("/orders/v0/orders", query);
    return { orders: p?.Orders ?? [], nextToken: p?.NextToken || null };
  }

  /** Every item on an order (follows item pages). */
  async getOrderItems(orderId: string): Promise<AmazonOrderItem[]> {
    const items: AmazonOrderItem[] = [];
    let nextToken: string | undefined;
    do {
      const p = await this.get<{ OrderItems?: AmazonOrderItem[]; NextToken?: string }>(
        `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
        nextToken ? { NextToken: nextToken } : {},
      );
      items.push(...(p?.OrderItems ?? []));
      nextToken = p?.NextToken || undefined;
    } while (nextToken);
    return items;
  }
}
