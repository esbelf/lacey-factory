// Minimal Shopify Admin GraphQL client: client-credentials login plus the
// calls we use (one order, orders updated since a time, webhook subscriptions).
import type { ShopifyOrder } from "./types";

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Throttled and 5xx: try again later. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

const MONEY = "shopMoney { amount currencyCode } presentmentMoney { amount currencyCode }";
const ADDRESS = "name firstName lastName company address1 address2 city province provinceCode zip country countryCodeV2 phone";
const TAX = `title rate ratePercentage priceSet { ${MONEY} }`;

/** Everything we keep about an order. Line items are capped at 50 to stay under the query cost limit. */
export const ORDER_FIELDS = `
  id legacyResourceId name createdAt processedAt updatedAt cancelledAt cancelReason
  displayFinancialStatus displayFulfillmentStatus email phone currencyCode presentmentCurrencyCode test sourceName
  subtotalPriceSet { ${MONEY} } totalDiscountsSet { ${MONEY} } totalShippingPriceSet { ${MONEY} }
  totalTaxSet { ${MONEY} } totalPriceSet { ${MONEY} }
  taxLines { ${TAX} }
  shippingLine { title code }
  customer { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  shippingAddress { ${ADDRESS} }
  billingAddress { ${ADDRESS} }
  lineItems(first: 50) {
    nodes {
      id sku name title variantTitle quantity vendor
      originalTotalSet { ${MONEY} } totalDiscountSet { ${MONEY} }
      taxLines { ${TAX} }
    }
  }
`;

export const WEBHOOK_TOPICS = ["ORDERS_PAID", "ORDERS_UPDATED", "ORDERS_CANCELLED"] as const;

export type ShopifyOptions = {
  /** lakemat-2.myshopify.com */
  shop: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export type OrdersPage = { orders: ShopifyOrder[]; nextCursor: string | null };

export class ShopifyAdmin {
  private token: { value: string; expiresAt: number } | null = null;
  private fetch: typeof fetch;
  private now: () => number;

  constructor(private opts: ShopifyOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Client-credentials tokens last about a day; refresh five minutes early. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 5 * 60_000) return this.token.value;
    const res = await this.fetch(`https://${this.opts.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new ShopifyError(
        `Shopify login failed: ${body.error_description ?? body.error ?? res.status}. Check SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.`,
        res.status,
        res.status >= 500,
      );
    }
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 86_399) * 1000 };
    return this.token.value;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetch(`https://${this.opts.shop}/admin/api/${this.opts.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": await this.accessToken() },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: T;
      errors?: { message?: string; extensions?: { code?: string } }[] | string;
    };
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) this.token = null;
      const detail = typeof body.errors === "string" ? body.errors : body.errors?.[0]?.message;
      throw new ShopifyError(`Shopify API failed (${res.status}): ${detail ?? "no details"}`, res.status, res.status === 429 || res.status >= 500);
    }
    const errors = Array.isArray(body.errors) ? body.errors : [];
    if (errors.length) {
      const throttled = errors.some((e) => e.extensions?.code === "THROTTLED");
      const access = errors.some((e) => e.extensions?.code === "ACCESS_DENIED");
      throw new ShopifyError(
        `Shopify API error: ${errors.map((e) => e.message).join("; ")}${access ? " (check the app's scopes and protected customer data access)" : ""}`,
        res.status,
        throttled,
      );
    }
    return body.data as T;
  }

  async getOrder(gid: string): Promise<ShopifyOrder | null> {
    const data = await this.graphql<{ order: ShopifyOrder | null }>(`query ($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: gid });
    return data.order;
  }

  /** Orders updated after `since` (ISO time), oldest update first, 10 per page. */
  async listOrders(since: string, cursor?: string | null): Promise<OrdersPage> {
    const data = await this.graphql<{ orders: { nodes: ShopifyOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      `query ($q: String!, $after: String) {
        orders(first: 10, after: $after, sortKey: UPDATED_AT, query: $q) {
          nodes { ${ORDER_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { q: `updated_at:>'${since}'`, after: cursor ?? null },
    );
    const { nodes, pageInfo } = data.orders;
    return { orders: nodes, nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null };
  }

  async listWebhooks(): Promise<{ id: string; topic: string; uri: string }[]> {
    const data = await this.graphql<{ webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] } }>(
      `{ webhookSubscriptions(first: 100) { nodes { id topic uri } } }`,
    );
    return data.webhookSubscriptions.nodes;
  }

  async createWebhook(topic: string, uri: string): Promise<void> {
    const data = await this.graphql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(
      `mutation ($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { message } }
      }`,
      { topic, sub: { uri, format: "JSON" } },
    );
    const errs = data.webhookSubscriptionCreate.userErrors;
    if (errs.length) throw new ShopifyError(`Couldn't subscribe to ${topic}: ${errs.map((e) => e.message).join("; ")}`, 200, false);
  }

  /** Subscribe to the order topics at `uri`, adding only what's missing. Returns the topics added. */
  async ensureWebhooks(uri: string): Promise<string[]> {
    const have = new Set((await this.listWebhooks()).filter((w) => w.uri === uri).map((w) => w.topic));
    const added: string[] = [];
    for (const topic of WEBHOOK_TOPICS) {
      if (have.has(topic)) continue;
      await this.createWebhook(topic, uri);
      added.push(topic);
    }
    return added;
  }
}
