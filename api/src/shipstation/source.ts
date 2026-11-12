// Where ShipStation labels are read from: the V2 API (live) or a local folder of
// JSON written by `npm run simulate:shipstation` (fake).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { shipstationConfig } from "../config";
import { type LabelQuery, ShipStationApi, ShipStationError } from "./api";
import { SHIPSTATION_EVENTS, type SsLabel, type SsLabelsPage, type SsShipment } from "./types";

export type WebhookSetup = { added: string[]; elsewhere: { event: string; url: string }[] };

export interface ShipStationSource {
  getLabel(labelId: string): Promise<SsLabel | null>;
  listLabels(q: LabelQuery): Promise<SsLabelsPage>;
  getShipment(shipmentId: string): Promise<SsShipment | null>;
  /** GET a webhook's resource_url (only on api.shipstation.com). */
  fetchResource(url: string): Promise<unknown>;
  /** Subscribe `url` to our events. One URL per event per account, so events pointing elsewhere are left alone. */
  ensureWebhooks(url: string): Promise<WebhookSetup>;
}

const notFound = (err: unknown) => err instanceof ShipStationError && err.status === 404;

export class LiveShipStationSource implements ShipStationSource {
  constructor(private api: ShipStationApi) {}

  async getLabel(labelId: string) {
    try {
      return await this.api.getLabel(labelId);
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  listLabels(q: LabelQuery) {
    return this.api.listLabels(q);
  }

  async getShipment(shipmentId: string) {
    try {
      return await this.api.getShipment(shipmentId);
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  fetchResource(url: string) {
    return this.api.request<unknown>(url);
  }

  async ensureWebhooks(url: string): Promise<WebhookSetup> {
    const existing = await this.api.listWebhooks();
    const out: WebhookSetup = { added: [], elsewhere: [] };
    for (const event of SHIPSTATION_EVENTS) {
      const hook = existing.find((w) => w.event === event);
      if (!hook) {
        await this.api.createWebhook(event, url);
        out.added.push(event);
      } else if (hook.url !== url) {
        out.elsewhere.push({ event, url: hook.url });
      }
    }
    return out;
  }
}

/** One file per label: { label, shipment }, in ShipStation's own JSON shape. */
export type FakeLabelFile = { label: SsLabel; shipment: SsShipment };

export class FakeShipStationSource implements ShipStationSource {
  constructor(private dir: string) {}

  async all(): Promise<FakeLabelFile[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    return Promise.all(
      files.filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(path.join(this.dir, f), "utf8")) as FakeLabelFile),
    );
  }

  async getLabel(labelId: string) {
    return (await this.all()).find((f) => f.label.label_id === labelId)?.label ?? null;
  }

  async listLabels(q: LabelQuery): Promise<SsLabelsPage> {
    const after = q.createdAtStart ? new Date(q.createdAtStart).getTime() : 0;
    const labels = (await this.all())
      .map((f) => f.label)
      .filter((l) => new Date(l.created_at ?? 0).getTime() >= after)
      .filter((l) => !q.status || l.status === q.status)
      .filter((l) => !q.shipmentId || l.shipment_id === q.shipmentId)
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.label_id.localeCompare(b.label_id));
    const size = q.pageSize ?? 100;
    const page = q.page ?? 1;
    return { labels: labels.slice((page - 1) * size, page * size), page, pages: Math.max(1, Math.ceil(labels.length / size)) };
  }

  async getShipment(shipmentId: string) {
    return (await this.all()).find((f) => f.shipment.shipment_id === shipmentId)?.shipment ?? null;
  }

  async fetchResource(url: string) {
    const u = new URL(url);
    const [, , kind, id] = u.pathname.split("/"); // /v2/labels/<id>
    if (kind === "labels" && id) return this.getLabel(id);
    if (kind === "shipments" && id) return this.getShipment(id);
    throw new ShipStationError(`Fake ShipStation doesn't serve ${u.pathname}`, 404, false);
  }

  async ensureWebhooks(): Promise<WebhookSetup> {
    return { added: [], elsewhere: [] };
  }
}

class MisconfiguredShipStationSource implements ShipStationSource {
  constructor(private message: string) {}
  private fail(): never {
    throw new ShipStationError(this.message, 0, false);
  }
  getLabel = () => this.fail();
  listLabels = () => this.fail();
  getShipment = () => this.fail();
  fetchResource = () => this.fail();
  ensureWebhooks = () => this.fail();
}

/** The source for the current SHIPSTATION_MODE, or null when ShipStation is off. */
export function shipstationSource(): ShipStationSource | null {
  const c = shipstationConfig();
  if (c.mode === "off") return null;
  if (c.mode === "fake") return new FakeShipStationSource(c.fakeDir);
  if (!c.apiKey) return new MisconfiguredShipStationSource("SHIPSTATION_MODE=live needs SHIPSTATION_API_KEY.");
  return new LiveShipStationSource(new ShipStationApi(c.apiKey));
}
