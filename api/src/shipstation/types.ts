// ShipStation API V2 shapes (the fields we read). https://docs.shipstation.com/openapi

export type SsMoney = { currency: string; amount: number };

export type SsLabel = {
  label_id: string;
  /** processing, completed, error, voided */
  status: string;
  shipment_id: string | null;
  external_shipment_id?: string | null;
  external_order_id?: string | null;
  ship_date?: string | null;
  created_at?: string | null;
  shipment_cost: SsMoney | null;
  insurance_cost?: SsMoney | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  carrier_code?: string | null;
  service_code?: string | null;
  voided?: boolean;
  voided_at?: string | null;
};

export type SsShipment = {
  shipment_id: string;
  /** shopify, amazon_us, amazon_ca… */
  order_source_code?: string | null;
  external_order_id?: string | null;
  external_shipment_id?: string | null;
  shipment_number?: string | null;
  store_id?: string | number | null;
  ship_date?: string | null;
  shipment_status?: string | null;
};

export type SsLabelsPage = { labels: SsLabel[]; page: number; pages: number };

export type SsWebhook = { webhook_id: string | number; event: string; url: string };

/**
 * A webhook delivery. ShipStation's docs show `resource_url` and `resource_type`,
 * sometimes with `data`; the exact body of the v2 label/shipped events isn't
 * documented, so we read whatever ids are there and fetch the rest.
 */
export type SsWebhookBody = {
  resource_url?: string;
  resource_type?: string;
  event?: string;
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
};

/** The events we subscribe to: a label bought (cost) and an order shipped. */
export const SHIPSTATION_EVENTS = ["label_created_v2", "fulfillment_shipped_v2"] as const;
