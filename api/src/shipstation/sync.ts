// ShipStation labels into the database. Webhooks call ingestEvent for one
// delivery; "Re-check shipments" pages labels since a time (begin → page → end).
import { sumMoney } from "@lacey-factory/shared/money";

import type { DB } from "../db/types";
import { markSyncDone, markSyncStarted, syncState } from "../domain/orders";
import { markShipped, rematchShipments, type ShipmentValues, upsertShipment } from "../domain/shipments";
import type { ShipStationSource } from "./source";
import type { SsLabel, SsShipment, SsWebhookBody } from "./types";

/** Re-read a few minutes before the last pull in case ShipStation was slow to list a label. */
const OVERLAP_MS = 10 * 60_000;
/** Voids have no webhook and no "voided since" filter, so recent voided labels are re-read. */
const VOID_LOOKBACK_DAYS = 30;

/** Our row for a label and its shipment. */
export function shipmentValues(label: SsLabel, shipment: SsShipment | null, shippedAt?: Date): ShipmentValues {
  const voided = label.voided || label.status === "voided";
  return {
    labelId: label.label_id,
    shipmentId: label.shipment_id ?? shipment?.shipment_id ?? null,
    orderSourceCode: shipment?.order_source_code ?? null,
    externalOrderId: shipment?.external_order_id ?? label.external_order_id ?? null,
    shipmentNumber: shipment?.shipment_number ?? label.external_shipment_id ?? shipment?.external_shipment_id ?? null,
    status: voided ? "voided" : label.status,
    carrierCode: label.carrier_code ?? null,
    serviceCode: label.service_code ?? null,
    trackingNumber: label.tracking_number ?? null,
    trackingUrl: label.tracking_url ?? null,
    shipDate: label.ship_date ? label.ship_date.slice(0, 10) : null,
    shippedAt: shippedAt ?? null,
    cost: sumMoney([label.shipment_cost?.amount ?? 0, label.insurance_cost?.amount ?? 0]),
    currency: label.shipment_cost?.currency?.toUpperCase() ?? null,
    voidedAt: voided ? new Date(label.voided_at ?? Date.now()) : null,
    raw: { label, shipment },
  };
}

/** Save labels, looking each shipment up once. Returns how many were linked to an order. */
async function saveLabels(db: DB, source: ShipStationSource, labels: SsLabel[], shippedAt?: Date): Promise<number> {
  const seen = new Map<string, SsShipment | null>();
  let matched = 0;
  for (const label of labels) {
    const sid = label.shipment_id;
    if (sid && !seen.has(sid)) seen.set(sid, await source.getShipment(sid));
    const r = await upsertShipment(db, shipmentValues(label, sid ? (seen.get(sid) ?? null) : null, shippedAt));
    if (r.orderId) matched++;
  }
  return matched;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every label in a fetched resource: a label, a shipment, or lists of either (or of fulfillments). */
async function labelsIn(source: ShipStationSource, r: unknown): Promise<SsLabel[]> {
  if (!isObj(r)) return [];
  if (str(r.label_id)) return [r as unknown as SsLabel];
  const out: SsLabel[] = [];
  if (Array.isArray(r.labels)) out.push(...(r.labels as SsLabel[]));
  const shipmentIds = [
    ...(str(r.shipment_id) ? [str(r.shipment_id) as string] : []),
    ...[r.shipments, r.fulfillments].flatMap((list) => (Array.isArray(list) ? list.map((x) => (isObj(x) ? str(x.shipment_id) : null)) : [])),
  ].filter((x): x is string => !!x);
  for (const id of new Set(shipmentIds)) out.push(...(await source.listLabels({ shipmentId: id })).labels);
  return out;
}

export type EventResult = { event: string; labels: number; matched: number };

/**
 * One webhook delivery. The body only says what changed; the labels are
 * fetched from ShipStation so we always save their current state.
 */
export async function ingestEvent(db: DB, source: ShipStationSource, body: SsWebhookBody, now = new Date()): Promise<EventResult> {
  const event = String(body.event ?? body.resource_type ?? "").toLowerCase();
  const shipped = event.includes("fulfillment_shipped");
  const data = isObj(body.data) ? body.data : {};
  const labelId = str(data.label_id) ?? str(body.label_id);
  const shipmentId = str(data.shipment_id) ?? str(body.shipment_id);

  let labels: SsLabel[] = [];
  if (labelId) {
    const l = await source.getLabel(labelId);
    if (l) labels = [l];
  } else if (shipmentId) {
    labels = (await source.listLabels({ shipmentId })).labels;
  } else if (body.resource_url) {
    labels = await labelsIn(source, await source.fetchResource(body.resource_url));
  }

  const matched = await saveLabels(db, source, labels, shipped ? now : undefined);
  if (shipped) {
    for (const sid of new Set([shipmentId, ...labels.map((l) => l.shipment_id)].filter((x): x is string => !!x))) {
      await markShipped(db, sid, now);
    }
  }
  if (labels.length) await markSyncDone(db, "shipstation", { cursor: null, ordersSeen: labels.length });
  return { event, labels: labels.length, matched };
}

/** Where a re-check starts (ISO time): the given date, else just before the last one, else 30 days back. */
export async function pullBegin(db: DB, since: string | null, now = new Date()): Promise<string> {
  await markSyncStarted(db, "shipstation");
  if (since) return new Date(since).toISOString();
  const state = await syncState(db, "shipstation");
  const start = state?.cursor ? new Date(state.cursor.getTime() - OVERLAP_MS) : new Date(now.getTime() - 30 * 86_400_000);
  return start.toISOString();
}

export type PullPageResult = { pages: number; count: number; maxCreated: string | null };

/** One page (1-based) of labels created since `since`. */
export async function pullPage(db: DB, source: ShipStationSource, since: string, page: number): Promise<PullPageResult> {
  const r = await source.listLabels({ createdAtStart: since, page, pageSize: 100 });
  await saveLabels(db, source, r.labels);
  const maxCreated = r.labels.map((l) => l.created_at ?? "").filter(Boolean).sort().pop() ?? null;
  return { pages: r.pages, count: r.labels.length, maxCreated };
}

/** Re-read recent voids, link labels that were waiting for their order, and move the cursor. */
export async function pullEnd(db: DB, source: ShipStationSource, maxCreated: string | null, count: number, now = new Date()) {
  const voidSince = new Date(now.getTime() - VOID_LOOKBACK_DAYS * 86_400_000).toISOString();
  for (let page = 1; ; page++) {
    const r = await source.listLabels({ status: "voided", createdAtStart: voidSince, page, pageSize: 100 });
    await saveLabels(db, source, r.labels);
    if (page >= r.pages || !r.labels.length) break;
  }
  await rematchShipments(db);
  await markSyncDone(db, "shipstation", { cursor: maxCreated ? new Date(maxCreated) : null, ordersSeen: count });
}
