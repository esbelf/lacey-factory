// Amazon order JSON → our orders / order_items rows. Pure, so it's easy to test.
import { type AmazonMoney, type AmazonOrder, type AmazonOrderItem, MARKETPLACES } from "./types";

export type OrderValues = {
  source: "amazon";
  externalId: string;
  marketplaceId: string | null;
  marketplace: string | null;
  salesChannel: string | null;
  status: string;
  fulfillmentChannel: string | null;
  orderType: string | null;
  purchasedAt: Date;
  lastUpdatedAt: Date;
  earliestShipDate: Date | null;
  latestShipDate: Date | null;
  latestDeliveryDate: Date | null;
  currency: string | null;
  orderTotal: number | null;
  itemsShipped: number | null;
  itemsUnshipped: number | null;
  paymentMethod: string | null;
  shipServiceLevel: string | null;
  isPrime: boolean;
  isBusiness: boolean;
  isReplacement: boolean;
  shipCity: string | null;
  shipState: string | null;
  shipPostalCode: string | null;
  shipCountry: string | null;
  raw: AmazonOrder;
};

export type OrderItemValues = {
  externalItemId: string;
  sku: string | null;
  asin: string | null;
  title: string | null;
  qtyOrdered: number;
  qtyShipped: number;
  itemPrice: number | null;
  itemTax: number | null;
  shippingPrice: number | null;
  shippingTax: number | null;
  promotionDiscount: number | null;
  raw: AmazonOrderItem;
};

export type NormalizedOrder = { order: OrderValues; items: OrderItemValues[] };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown) => (str(v) ? new Date(v as string) : null);

/** "12.34" → 12.34; missing or unparseable → null. */
export function money(m: AmazonMoney | undefined): number | null {
  if (!m?.Amount) return null;
  const n = Number(m.Amount);
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null;
}

export function normalizeAmazonOrder(o: AmazonOrder, items: AmazonOrderItem[]): NormalizedOrder {
  const marketplaceId = str(o.MarketplaceId);
  const addr = o.ShippingAddress ?? {};
  return {
    order: {
      source: "amazon",
      externalId: o.AmazonOrderId,
      marketplaceId,
      marketplace: marketplaceId ? (MARKETPLACES[marketplaceId] ?? marketplaceId) : null,
      salesChannel: str(o.SalesChannel),
      status: o.OrderStatus,
      fulfillmentChannel: str(o.FulfillmentChannel),
      orderType: str(o.OrderType),
      purchasedAt: new Date(o.PurchaseDate),
      lastUpdatedAt: new Date(o.LastUpdateDate),
      earliestShipDate: date(o.EarliestShipDate),
      latestShipDate: date(o.LatestShipDate),
      latestDeliveryDate: date(o.LatestDeliveryDate),
      currency: str(o.OrderTotal?.CurrencyCode),
      orderTotal: money(o.OrderTotal),
      itemsShipped: o.NumberOfItemsShipped ?? null,
      itemsUnshipped: o.NumberOfItemsUnshipped ?? null,
      paymentMethod: str(o.PaymentMethod),
      shipServiceLevel: str(o.ShipServiceLevel),
      isPrime: o.IsPrime === true,
      isBusiness: o.IsBusinessOrder === true,
      isReplacement: o.IsReplacementOrder === true || o.IsReplacementOrder === "true",
      shipCity: str(addr.City),
      shipState: str(addr.StateOrRegion),
      shipPostalCode: str(addr.PostalCode),
      shipCountry: str(addr.CountryCode),
      raw: o,
    },
    items: items.map((i) => ({
      externalItemId: i.OrderItemId,
      sku: str(i.SellerSKU),
      asin: str(i.ASIN),
      title: str(i.Title),
      qtyOrdered: i.QuantityOrdered,
      qtyShipped: i.QuantityShipped ?? 0,
      itemPrice: money(i.ItemPrice),
      itemTax: money(i.ItemTax),
      shippingPrice: money(i.ShippingPrice),
      shippingTax: money(i.ShippingTax),
      promotionDiscount: money(i.PromotionDiscount),
      raw: i,
    })),
  };
}
