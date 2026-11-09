// The parts of a Shopify Admin GraphQL Order we read (ORDER_FIELDS in
// admin-api.ts). The whole node is kept in orders.raw.
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Order

export type ShopifyMoney = { amount: string; currencyCode: string };
/** shopMoney is the store's currency; presentmentMoney is what the customer saw. */
export type ShopifyMoneyBag = { shopMoney: ShopifyMoney; presentmentMoney?: ShopifyMoney };

export type ShopifyTaxLine = { title: string; rate: number | null; ratePercentage?: number | null; priceSet: ShopifyMoneyBag };

export type ShopifyAddress = {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  country?: string | null;
  countryCodeV2?: string | null;
  phone?: string | null;
};

export type ShopifyLineItem = {
  id: string;
  sku: string | null;
  name: string;
  title?: string;
  variantTitle?: string | null;
  quantity: number;
  originalTotalSet: ShopifyMoneyBag;
  totalDiscountSet?: ShopifyMoneyBag | null;
  taxLines?: ShopifyTaxLine[];
  [key: string]: unknown;
};

export type ShopifyOrder = {
  /** gid://shopify/Order/123 */
  id: string;
  /** "#1001" */
  name: string;
  createdAt: string;
  processedAt?: string | null;
  updatedAt: string;
  cancelledAt?: string | null;
  /** PAID, PENDING, AUTHORIZED, PARTIALLY_PAID, PARTIALLY_REFUNDED, REFUNDED, VOIDED, EXPIRED */
  displayFinancialStatus: string | null;
  displayFulfillmentStatus?: string | null;
  email?: string | null;
  phone?: string | null;
  currencyCode: string;
  subtotalPriceSet?: ShopifyMoneyBag | null;
  totalDiscountsSet?: ShopifyMoneyBag | null;
  totalShippingPriceSet?: ShopifyMoneyBag | null;
  totalTaxSet?: ShopifyMoneyBag | null;
  totalPriceSet: ShopifyMoneyBag;
  taxLines?: ShopifyTaxLine[];
  shippingLine?: { title?: string | null; code?: string | null } | null;
  customer?: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    defaultEmailAddress?: { emailAddress?: string | null } | null;
    defaultPhoneNumber?: { phoneNumber?: string | null } | null;
  } | null;
  shippingAddress?: ShopifyAddress | null;
  billingAddress?: ShopifyAddress | null;
  lineItems: { nodes: ShopifyLineItem[] };
  [key: string]: unknown;
};

/** Numeric id from a GID: gid://shopify/Order/123 → "123". */
export const shopifyNumericId = (gid: string) => gid.split("/").pop() ?? gid;
export const orderGid = (id: string | number) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/Order/${id}`);
