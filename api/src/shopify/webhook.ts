// Checking and reading Shopify webhook deliveries.
// https://shopify.dev/docs/apps/build/webhooks/subscribe/https
import { createHmac, timingSafeEqual } from "node:crypto";

import { orderGid } from "./types";

/** Shopify signs the raw body with the app's client secret (base64 HMAC-SHA256). */
export function verifyShopifyHmac(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(header, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signShopifyBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

/** Topics that bring an order in or change it. */
export const ORDER_TOPICS = new Set(["orders/paid", "orders/updated", "orders/cancelled"]);

export type OrderWebhook = { topic: string; shop: string; webhookId: string; orderGid: string };

/** The order a delivery is about, or null when the body has no order id. */
export function parseOrderWebhook(headers: (name: string) => string | undefined, rawBody: string): OrderWebhook | null {
  let body: { id?: number | string; admin_graphql_api_id?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const gid = body.admin_graphql_api_id ?? (body.id != null ? orderGid(body.id) : null);
  if (!gid) return null;
  return {
    topic: headers("x-shopify-topic") ?? "",
    shop: headers("x-shopify-shop-domain") ?? "",
    webhookId: headers("x-shopify-webhook-id") ?? headers("x-shopify-event-id") ?? `${Date.now()}`,
    orderGid: gid,
  };
}
