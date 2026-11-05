// Where order sync reads Amazon orders from: SP-API (sandbox or live) or a
// local folder of JSON orders written by `npm run simulate:amazon` (fake).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { amazonConfig } from "../config";
import { SpApi, SpApiError } from "./sp-api";
import type { AmazonOrder, AmazonOrderItem } from "./types";

export interface OrderSource {
  /** Orders updated after `since` (ISO time), one page at a time. */
  listOrders(since: string, nextToken?: string | null): Promise<{ orders: AmazonOrder[]; nextToken: string | null }>;
  getOrderItems(orderId: string): Promise<AmazonOrderItem[]>;
  /** Pause between item calls (getOrderItems allows ~0.5/s sustained). */
  readonly itemDelayMs: number;
}

export class LiveOrderSource implements OrderSource {
  readonly itemDelayMs = 2100;
  constructor(
    private api: SpApi,
    private marketplaceIds: string[],
  ) {}

  listOrders(since: string, nextToken?: string | null) {
    return this.api.getOrders({ marketplaceIds: this.marketplaceIds, lastUpdatedAfter: since, nextToken });
  }

  getOrderItems(orderId: string) {
    return this.api.getOrderItems(orderId);
  }
}

/** One file per order: { order, items }, in SP-API's own JSON shape. */
export type FakeOrderFile = { order: AmazonOrder; items: AmazonOrderItem[] };

export class FakeOrderSource implements OrderSource {
  readonly itemDelayMs = 0;
  constructor(
    private dir: string,
    private pageSize = 100,
  ) {}

  private async all(): Promise<FakeOrderFile[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    return Promise.all(
      files.filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(path.join(this.dir, f), "utf8")) as FakeOrderFile),
    );
  }

  async listOrders(since: string, nextToken?: string | null) {
    const after = new Date(since).getTime();
    const updated = (await this.all())
      .map((f) => f.order)
      .filter((o) => new Date(o.LastUpdateDate).getTime() > after)
      .sort((a, b) => a.LastUpdateDate.localeCompare(b.LastUpdateDate) || a.AmazonOrderId.localeCompare(b.AmazonOrderId));
    const start = Number(nextToken ?? 0);
    const end = start + this.pageSize;
    return { orders: updated.slice(start, end), nextToken: end < updated.length ? String(end) : null };
  }

  async getOrderItems(orderId: string) {
    const file = (await this.all()).find((f) => f.order.AmazonOrderId === orderId);
    return file?.items ?? [];
  }
}

class MisconfiguredOrderSource implements OrderSource {
  readonly itemDelayMs = 0;
  constructor(private message: string) {}
  listOrders(): never {
    throw new SpApiError(this.message, 0, false);
  }
  getOrderItems(): never {
    throw new SpApiError(this.message, 0, false);
  }
}

/** The source for the current AMAZON_MODE, or null when Amazon is off. */
export function orderSource(): OrderSource | null {
  const c = amazonConfig();
  if (c.mode === "off") return null;
  if (c.mode === "fake") return new FakeOrderSource(c.fakeDir);
  if (!c.clientId || !c.clientSecret || !c.refreshToken) {
    // Don't stop the worker (it also reads supplier email); each sync reports this instead.
    return new MisconfiguredOrderSource(
      `AMAZON_MODE=${c.mode} needs AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET and AMAZON_REFRESH_TOKEN in .env.`,
    );
  }
  const api = new SpApi({ mode: c.mode, clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refreshToken });
  return new LiveOrderSource(api, c.marketplaceIds);
}
