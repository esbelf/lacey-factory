// The parts of SP-API Orders v0 responses we read. Amazon sends more; every
// field is kept as-is in orders.raw / order_items.raw.
// https://developer-docs.amazon.com/sp-api/docs/orders-api-v0-reference

export type AmazonMoney = { CurrencyCode?: string; Amount?: string };

export type AmazonOrder = {
  AmazonOrderId: string;
  PurchaseDate: string;
  LastUpdateDate: string;
  OrderStatus: string;
  MarketplaceId?: string;
  SalesChannel?: string;
  FulfillmentChannel?: string;
  OrderType?: string;
  OrderTotal?: AmazonMoney;
  NumberOfItemsShipped?: number;
  NumberOfItemsUnshipped?: number;
  PaymentMethod?: string;
  ShipServiceLevel?: string;
  EarliestShipDate?: string;
  LatestShipDate?: string;
  LatestDeliveryDate?: string;
  IsPrime?: boolean;
  IsBusinessOrder?: boolean;
  IsReplacementOrder?: boolean | string;
  ShippingAddress?: { City?: string; StateOrRegion?: string; PostalCode?: string; CountryCode?: string };
  [key: string]: unknown;
};

export type AmazonOrderItem = {
  OrderItemId: string;
  ASIN?: string;
  SellerSKU?: string;
  Title?: string;
  QuantityOrdered: number;
  QuantityShipped?: number;
  ItemPrice?: AmazonMoney;
  ItemTax?: AmazonMoney;
  ShippingPrice?: AmazonMoney;
  ShippingTax?: AmazonMoney;
  PromotionDiscount?: AmazonMoney;
  [key: string]: unknown;
};

export const MARKETPLACES: Record<string, string> = {
  ATVPDKIKX0DER: "US",
  A2EUQ1WTGCTBG2: "CA",
  A1AM78C64UM0Y8: "MX",
};
