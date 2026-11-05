// Sample Amazon orders in SP-API's JSON shape, for fake mode and tests.
// PLACEHOLDER SKUs: replace with LakeMat's real Amazon SKUs once we have the list.
import type { FakeOrderFile } from "./order-source";
import type { AmazonOrderItem } from "./types";

export const SAMPLE_SKUS = {
  lakeMatXL: "LM-XL",
  lakeMatL: "LM-L",
  muckMatXL: "MM-XL",
  dockMat: "DM-REG",
  lakeMatXL2Pack: "LM-XL-2PK",
  unknown: "MYSTERY-SKU-1",
};

export const MARKETPLACE_IDS = { US: "ATVPDKIKX0DER", CA: "A2EUQ1WTGCTBG2" } as const;

const CURRENCY = { US: "USD", CA: "CAD" } as const;
const CHANNEL = { US: "Amazon.com", CA: "Amazon.ca" } as const;
const ADDRESS = {
  US: { City: "TRAVERSE CITY", StateOrRegion: "MI", PostalCode: "49684-1234", CountryCode: "US" },
  CA: { City: "KELOWNA", StateOrRegion: "BC", PostalCode: "V1Y 1A1", CountryCode: "CA" },
};

const amount = (n: number, market: keyof typeof CURRENCY) => ({ CurrencyCode: CURRENCY[market], Amount: n.toFixed(2) });

/** A random Amazon-style order number: 112-1234567-1234567 (Canada's start with 70x). */
export function fakeOrderId(market: "US" | "CA" = "US") {
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
  return `${market === "CA" ? "70" : "11"}${digits(1)}-${digits(7)}-${digits(7)}`;
}

export function fakeOrder(input: {
  id?: string;
  market: "US" | "CA";
  status?: string;
  purchasedAt?: string;
  updatedAt?: string;
  items: { sku: string; qty: number; price: number; title?: string }[];
}): FakeOrderFile {
  const id = input.id ?? fakeOrderId(input.market);
  const purchasedAt = input.purchasedAt ?? new Date().toISOString();
  const status = input.status ?? "Unshipped";
  const m = input.market;
  const total = input.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const shipped = status === "Shipped" ? input.items.reduce((s, i) => s + i.qty, 0) : 0;
  const items: AmazonOrderItem[] = input.items.map((i, n) => ({
    ASIN: `B0FAKE${String(n + 1).padStart(4, "0")}`,
    SellerSKU: i.sku,
    OrderItemId: `${id.replace(/-/g, "").slice(-8)}${String(n + 1).padStart(6, "0")}`,
    Title: i.title ?? `LakeMat ${i.sku} weed barrier mat`,
    QuantityOrdered: i.qty,
    QuantityShipped: status === "Shipped" ? i.qty : 0,
    ProductInfo: { NumberOfItems: "1" },
    ItemPrice: amount(i.price * i.qty, m),
    ItemTax: amount(Math.round(i.price * i.qty * 6) / 100, m),
    ShippingPrice: amount(0, m),
    ShippingTax: amount(0, m),
    PromotionDiscount: amount(0, m),
    IsGift: "false",
    ConditionId: "New",
    IsTransparency: false,
  }));
  return {
    order: {
      AmazonOrderId: id,
      PurchaseDate: purchasedAt,
      LastUpdateDate: input.updatedAt ?? purchasedAt,
      OrderStatus: status,
      FulfillmentChannel: "MFN",
      SalesChannel: CHANNEL[m],
      ShipServiceLevel: "Std US D2D Dom",
      ShipmentServiceLevelCategory: "Standard",
      OrderTotal: amount(total, m),
      NumberOfItemsShipped: shipped,
      NumberOfItemsUnshipped: input.items.reduce((s, i) => s + i.qty, 0) - shipped,
      PaymentMethod: "Other",
      PaymentMethodDetails: ["Standard"],
      MarketplaceId: MARKETPLACE_IDS[m],
      OrderType: "StandardOrder",
      EarliestShipDate: purchasedAt,
      LatestShipDate: new Date(new Date(purchasedAt).getTime() + 2 * 86_400_000).toISOString(),
      LatestDeliveryDate: new Date(new Date(purchasedAt).getTime() + 7 * 86_400_000).toISOString(),
      IsBusinessOrder: false,
      IsPrime: false,
      IsPremiumOrder: false,
      IsGlobalExpressEnabled: false,
      IsReplacementOrder: "false",
      IsSoldByAB: false,
      IsISPU: false,
      IsAccessPointOrder: false,
      HasRegulatedItems: false,
      ShippingAddress: ADDRESS[m],
    },
    items,
  };
}
