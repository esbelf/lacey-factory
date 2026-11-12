// Sample ShipStation labels for tests and `npm run simulate:shipstation`.
import { randomUUID } from "node:crypto";

import type { FakeLabelFile } from "./source";

export type FakeLabelInput = {
  /** shopify, amazon_us, amazon_ca… */
  orderSourceCode: string;
  /** Amazon order number, or Shopify's numeric order id. */
  externalOrderId: string;
  /** Shopify's order number without the # (ShipStation's shipment_number). */
  shipmentNumber?: string;
  cost?: number;
  insurance?: number;
  currency?: string;
  shipmentId?: string;
  labelId?: string;
  createdAt?: string;
  voided?: boolean;
};

export function fakeLabel(i: FakeLabelInput): FakeLabelFile {
  const shipmentId = i.shipmentId ?? `se-${randomUUID().slice(0, 8)}`;
  const createdAt = i.createdAt ?? new Date().toISOString();
  const currency = (i.currency ?? "USD").toLowerCase();
  return {
    label: {
      label_id: i.labelId ?? `se-label-${randomUUID().slice(0, 8)}`,
      status: i.voided ? "voided" : "completed",
      shipment_id: shipmentId,
      external_order_id: i.externalOrderId,
      ship_date: createdAt.slice(0, 10) + "T00:00:00Z",
      created_at: createdAt,
      shipment_cost: { currency, amount: i.cost ?? 18.42 },
      insurance_cost: { currency, amount: i.insurance ?? 0 },
      tracking_number: `1Z${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`,
      tracking_url: "https://www.ups.com/track?tracknum=1Z",
      carrier_code: "ups",
      service_code: "ups_ground",
      voided: !!i.voided,
      voided_at: i.voided ? new Date().toISOString() : null,
    },
    shipment: {
      shipment_id: shipmentId,
      order_source_code: i.orderSourceCode,
      external_order_id: i.externalOrderId,
      shipment_number: i.shipmentNumber ?? null,
      shipment_status: "label_purchased",
    },
  };
}
