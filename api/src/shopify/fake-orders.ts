// Sample Shopify orders in the Admin GraphQL shape, for fake mode and tests.
// Tax rates are the real ones for Michigan and Ontario; SKUs are the Amazon placeholders.
import { SAMPLE_SKUS } from "../amazon/fake-orders";
import type { ShopifyAddress, ShopifyMoneyBag, ShopifyOrder, ShopifyTaxLine } from "./types";

export { SAMPLE_SKUS };

export type FakeRegion = "MI" | "OH" | "ON" | "BC";

const ADDRESSES: Record<FakeRegion, Omit<ShopifyAddress, "name" | "firstName" | "lastName">> = {
  MI: { address1: "123 Lakeshore Dr", city: "Traverse City", province: "Michigan", provinceCode: "MI", zip: "49684", country: "United States", countryCodeV2: "US" },
  OH: { address1: "45 Erie St", city: "Sandusky", province: "Ohio", provinceCode: "OH", zip: "44870", country: "United States", countryCodeV2: "US" },
  ON: { address1: "9 Muskoka Rd", city: "Gravenhurst", province: "Ontario", provinceCode: "ON", zip: "P1P 1A1", country: "Canada", countryCodeV2: "CA" },
  BC: { address1: "77 Okanagan Ave", city: "Kelowna", province: "British Columbia", provinceCode: "BC", zip: "V1Y 1A1", country: "Canada", countryCodeV2: "CA" },
};

/** Which taxes Shopify charges by ship-to region (Ohio: none, we have no nexus). */
const TAXES: Record<FakeRegion, { title: string; rate: number }[]> = {
  MI: [{ title: "Michigan State Tax", rate: 0.06 }],
  OH: [],
  ON: [{ title: "HST", rate: 0.13 }],
  BC: [
    { title: "GST", rate: 0.05 },
    { title: "BC PST", rate: 0.07 },
  ],
};

const money = (n: number): ShopifyMoneyBag => ({
  shopMoney: { amount: n.toFixed(2), currencyCode: "USD" },
  presentmentMoney: { amount: n.toFixed(2), currencyCode: "USD" },
});
const round = (n: number) => Math.round(n * 100) / 100;
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

export type FakeCustomer = { id?: string | null; email: string; firstName: string; lastName: string; phone?: string | null };

export const SAMPLE_CUSTOMERS = {
  pat: { id: "gid://shopify/Customer/7001", email: "pat.walsh@example.com", firstName: "Pat", lastName: "Walsh", phone: "+12315550101" },
  renee: { id: "gid://shopify/Customer/7002", email: "renee.tremblay@example.ca", firstName: "Renée", lastName: "Tremblay", phone: "+17055550199" },
  /** Checks out as a guest (no Shopify customer). */
  sam: { id: null, email: "sam.k@example.com", firstName: "Sam", lastName: "Kowalski", phone: null },
} satisfies Record<string, FakeCustomer>;

export function fakeShopifyOrder(input: {
  id?: number;
  number?: number;
  region: FakeRegion;
  customer: FakeCustomer;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  shipping?: number;
  discount?: number;
  items: { sku: string | null; qty: number; price: number; title?: string }[];
}): ShopifyOrder {
  const id = input.id ?? Number(`6${digits(12)}`);
  const number = input.number ?? 1000 + Math.floor(Math.random() * 9000);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const shipping = input.shipping ?? 0;
  const discount = input.discount ?? 0;
  const subtotal = round(input.items.reduce((s, i) => s + i.price * i.qty, 0));
  const taxable = subtotal - discount + shipping;
  const rates = TAXES[input.region];
  const taxLines: ShopifyTaxLine[] = rates.map((t) => ({ title: t.title, rate: t.rate, ratePercentage: t.rate * 100, priceSet: money(round(taxable * t.rate)) }));
  const tax = round(taxLines.reduce((s, t) => s + Number(t.priceSet.shopMoney.amount), 0));
  const c = input.customer;
  const addr = { ...ADDRESSES[input.region], name: `${c.firstName} ${c.lastName}`, firstName: c.firstName, lastName: c.lastName, company: null, address2: null, phone: c.phone ?? null };
  return {
    id: `gid://shopify/Order/${id}`,
    legacyResourceId: String(id),
    name: `#${number}`,
    createdAt,
    processedAt: createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    cancelledAt: null,
    cancelReason: null,
    displayFinancialStatus: input.status ?? "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    email: c.email,
    phone: c.phone ?? null,
    currencyCode: "USD",
    presentmentCurrencyCode: "USD",
    test: false,
    sourceName: "web",
    subtotalPriceSet: money(subtotal),
    totalDiscountsSet: money(discount),
    totalShippingPriceSet: money(shipping),
    totalTaxSet: money(tax),
    totalPriceSet: money(round(subtotal - discount + shipping + tax)),
    taxLines,
    shippingLine: shipping ? { title: "Standard Shipping", code: "standard" } : { title: "Free Shipping", code: "free" },
    customer: c.id
      ? { id: c.id, firstName: c.firstName, lastName: c.lastName, defaultEmailAddress: { emailAddress: c.email }, defaultPhoneNumber: c.phone ? { phoneNumber: c.phone } : null }
      : null,
    shippingAddress: addr,
    billingAddress: addr,
    lineItems: {
      nodes: input.items.map((i, n) => {
        const line = round(i.price * i.qty);
        return {
          id: `gid://shopify/LineItem/${id}${n + 1}`,
          sku: i.sku,
          name: i.title ?? `LakeMat ${i.sku ?? "item"}`,
          title: i.title ?? `LakeMat ${i.sku ?? "item"}`,
          variantTitle: null,
          quantity: i.qty,
          vendor: "LakeMat",
          originalTotalSet: money(line),
          totalDiscountSet: money(0),
          taxLines: rates.map((t) => ({ title: t.title, rate: t.rate, priceSet: money(round(line * t.rate)) })),
          variant: { id: `gid://shopify/ProductVariant/${n + 1}` },
          product: { id: `gid://shopify/Product/${n + 1}` },
        };
      }),
    },
  };
}
