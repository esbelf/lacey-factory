// Where Shopify orders are read from: the Admin API (live) or a local folder
// of order JSON written by `npm run simulate:shopify` (fake).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { shopifyConfig } from "../config";
import { ShopifyAdmin, ShopifyError, type OrdersPage } from "./admin-api";
import type { ShopifyOrder } from "./types";

export interface ShopifySource {
  getOrder(gid: string): Promise<ShopifyOrder | null>;
  /** Orders updated after `since` (ISO time), one page at a time. */
  listOrders(since: string, cursor?: string | null): Promise<OrdersPage>;
  /** Subscribe to the order webhooks at `uri`; returns topics added. */
  ensureWebhooks(uri: string): Promise<string[]>;
}

export class LiveShopifySource implements ShopifySource {
  constructor(private api: ShopifyAdmin) {}
  getOrder(gid: string) {
    return this.api.getOrder(gid);
  }
  listOrders(since: string, cursor?: string | null) {
    return this.api.listOrders(since, cursor);
  }
  ensureWebhooks(uri: string) {
    return this.api.ensureWebhooks(uri);
  }
}

/** One file per order, in the Admin GraphQL shape. */
export class FakeShopifySource implements ShopifySource {
  constructor(
    private dir: string,
    private pageSize = 10,
  ) {}

  async all(): Promise<ShopifyOrder[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    return Promise.all(
      files.filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(path.join(this.dir, f), "utf8")) as ShopifyOrder),
    );
  }

  async getOrder(gid: string) {
    return (await this.all()).find((o) => o.id === gid) ?? null;
  }

  async listOrders(since: string, cursor?: string | null) {
    const after = new Date(since).getTime();
    const updated = (await this.all())
      .filter((o) => new Date(o.updatedAt).getTime() > after)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    const start = Number(cursor ?? 0);
    const end = start + this.pageSize;
    return { orders: updated.slice(start, end), nextCursor: end < updated.length ? String(end) : null };
  }

  async ensureWebhooks() {
    return [];
  }
}

class MisconfiguredShopifySource implements ShopifySource {
  constructor(private message: string) {}
  getOrder(): never {
    throw new ShopifyError(this.message, 0, false);
  }
  listOrders(): never {
    throw new ShopifyError(this.message, 0, false);
  }
  ensureWebhooks(): never {
    throw new ShopifyError(this.message, 0, false);
  }
}

/** The source for the current SHOPIFY_MODE, or null when Shopify is off. */
export function shopifySource(): ShopifySource | null {
  const c = shopifyConfig();
  if (c.mode === "off") return null;
  if (c.mode === "fake") return new FakeShopifySource(c.fakeDir);
  if (!c.clientId || !c.clientSecret) {
    return new MisconfiguredShopifySource("SHOPIFY_MODE=live needs SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env.");
  }
  return new LiveShopifySource(
    new ShopifyAdmin({ shop: c.shop, clientId: c.clientId, clientSecret: c.clientSecret, apiVersion: c.apiVersion }),
  );
}
