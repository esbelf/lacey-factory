// Shopify GraphQL order → our orders / order_items / customer values. Pure, so it's easy to test.
// Money columns use the store's currency (shopMoney); raw keeps what the customer saw too.
import { sumMoney } from "@lacey-factory/shared/money";

import type { Address, TaxLine } from "../db/schema";
import type { NormalizedOrder } from "../domain/orders";
import type { ShopifyAddress, ShopifyMoneyBag, ShopifyOrder, ShopifyTaxLine } from "./types";

/** The store we read orders from; shown as the order's market. */
export const SHOPIFY_MARKET = "US";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** "12.34" → 12.34; missing or unparseable → null. */
export function shopMoney(m: ShopifyMoneyBag | null | undefined): number | null {
  const n = Number(m?.shopMoney?.amount);
  return m?.shopMoney?.amount != null && Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null;
}

export function address(a: ShopifyAddress | null | undefined): Address | null {
  if (!a) return null;
  const name = str(a.name) ?? (str([a.firstName, a.lastName].filter(Boolean).join(" ")) || null);
  return {
    name,
    company: str(a.company),
    address1: str(a.address1),
    address2: str(a.address2),
    city: str(a.city),
    province: str(a.province),
    provinceCode: str(a.provinceCode),
    zip: str(a.zip),
    country: str(a.country),
    countryCode: str(a.countryCodeV2),
    phone: str(a.phone),
  };
}

function taxLines(lines: ShopifyTaxLine[] | undefined): TaxLine[] {
  return (lines ?? [])
    .map((t) => ({ title: t.title, rate: t.rate ?? null, amount: shopMoney(t.priceSet) ?? 0 }))
    .filter((t) => t.amount !== 0);
}

export function normalizeShopifyOrder(o: ShopifyOrder): NormalizedOrder {
  const ship = address(o.shippingAddress);
  const bill = address(o.billingAddress);
  const c = o.customer;
  const email = str(o.email) ?? str(c?.defaultEmailAddress?.emailAddress);
  const units = o.lineItems.nodes.reduce((s, i) => s + i.quantity, 0);
  return {
    order: {
      source: "shopify",
      externalId: o.id,
      orderName: str(o.name),
      marketplace: SHOPIFY_MARKET,
      salesChannel: str(o.sourceName),
      status: o.displayFinancialStatus ?? "UNKNOWN",
      fulfillmentStatus: str(o.displayFulfillmentStatus),
      canceledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
      purchasedAt: new Date(o.processedAt ?? o.createdAt),
      lastUpdatedAt: new Date(o.updatedAt),
      currency: o.currencyCode,
      orderTotal: shopMoney(o.totalPriceSet),
      subtotal: shopMoney(o.subtotalPriceSet),
      discountTotal: shopMoney(o.totalDiscountsSet),
      shippingCharged: shopMoney(o.totalShippingPriceSet),
      taxTotal: shopMoney(o.totalTaxSet),
      taxLines: taxLines(o.taxLines),
      shipServiceLevel: str(o.shippingLine?.title),
      itemsShipped: o.displayFulfillmentStatus === "FULFILLED" ? units : null,
      itemsUnshipped: o.displayFulfillmentStatus === "FULFILLED" ? 0 : null,
      email,
      phone: str(o.phone) ?? ship?.phone ?? bill?.phone ?? null,
      shippingAddress: ship,
      billingAddress: bill,
      shipCity: ship?.city ?? null,
      shipState: ship?.provinceCode ?? null,
      shipPostalCode: ship?.zip ?? null,
      shipCountry: ship?.countryCode ?? null,
      raw: o,
    },
    items: o.lineItems.nodes.map((i) => ({
      externalItemId: i.id,
      sku: str(i.sku),
      title: str(i.name),
      qtyOrdered: i.quantity,
      qtyShipped: 0,
      itemPrice: shopMoney(i.originalTotalSet),
      itemTax: i.taxLines?.length ? sumMoney(i.taxLines.map((t) => shopMoney(t.priceSet) ?? 0)) : null,
      promotionDiscount: shopMoney(i.totalDiscountSet),
      raw: i,
    })),
    customer:
      c || email
        ? {
            externalId: c?.id ?? null,
            email,
            firstName: str(c?.firstName) ?? str(bill?.name?.split(" ")[0]) ?? null,
            lastName: str(c?.lastName) ?? (bill?.name?.includes(" ") ? str(bill.name.split(" ").slice(1).join(" ")) : null),
            phone: str(c?.defaultPhoneNumber?.phoneNumber) ?? str(o.phone),
          }
        : null,
  };
}
