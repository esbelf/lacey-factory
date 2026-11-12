// Minimal ShipStation API V2 client: labels, shipments and webhook subscriptions.
// Auth is one key in the API-Key header. https://docs.shipstation.com/authentication
import type { SsLabel, SsLabelsPage, SsShipment, SsWebhook } from "./types";

export const SHIPSTATION_HOST = "api.shipstation.com";

export class ShipStationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Throttled and 5xx: try again later. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ShipStationError";
  }
}

export type LabelQuery = { createdAtStart?: string; status?: string; shipmentId?: string; page?: number; pageSize?: number };

export class ShipStationApi {
  private fetch: typeof fetch;

  constructor(
    private apiKey: string,
    opts: { fetch?: typeof fetch } = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
  }

  /** GET or POST a V2 path, or a full URL on api.shipstation.com (a webhook's resource_url). */
  async request<T>(pathOrUrl: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = new URL(pathOrUrl, `https://${SHIPSTATION_HOST}`);
    if (url.protocol !== "https:" || url.hostname !== SHIPSTATION_HOST) {
      throw new ShipStationError(`Refusing to call ${url.hostname}: only ${SHIPSTATION_HOST} is allowed.`, 0, false);
    }
    const res = await this.fetch(url, {
      method: init.method ?? "GET",
      headers: { "API-Key": this.apiKey, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      const hint = res.status === 401 ? " Check SHIPSTATION_API_KEY." : "";
      throw new ShipStationError(`ShipStation ${res.status} on ${url.pathname}: ${text.slice(0, 300)}${hint}`, res.status, retryable);
    }
    return (await res.json()) as T;
  }

  getLabel(labelId: string) {
    return this.request<SsLabel>(`/v2/labels/${encodeURIComponent(labelId)}`);
  }

  listLabels(q: LabelQuery): Promise<SsLabelsPage> {
    const p = new URLSearchParams({ page: String(q.page ?? 1), page_size: String(q.pageSize ?? 100), sort_by: "created_at", sort_dir: "asc" });
    if (q.createdAtStart) p.set("created_at_start", q.createdAtStart);
    if (q.status) p.set("label_status", q.status);
    if (q.shipmentId) p.set("shipment_id", q.shipmentId);
    return this.request<SsLabelsPage>(`/v2/labels?${p}`);
  }

  getShipment(shipmentId: string) {
    return this.request<SsShipment>(`/v2/shipments/${encodeURIComponent(shipmentId)}`);
  }

  async listWebhooks(): Promise<SsWebhook[]> {
    const r = await this.request<SsWebhook[] | { webhooks?: SsWebhook[] }>("/v2/environment/webhooks");
    return Array.isArray(r) ? r : (r.webhooks ?? []);
  }

  createWebhook(event: string, url: string) {
    return this.request<SsWebhook>("/v2/environment/webhooks", { method: "POST", body: { name: `LakeMat Factory ${event}`, event, url } });
  }
}
