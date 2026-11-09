import clsx from "clsx";

import { post, type Product } from "../api";
import { ActionForm, SubmitButton } from "./action-form";
import { Field, Input, Select } from "./ui";

export type ItemState = "waiting" | "recorded" | "needs_mapping" | "needs_recipe" | "canceled" | "ignored";

const ITEM_STATE: Record<ItemState, { label: string; tone: string }> = {
  recorded: { label: "Taken from stock", tone: "bg-brand/15 text-brand-strong" },
  waiting: { label: "Waiting for payment", tone: "bg-warn/20 text-ink" },
  needs_mapping: { label: "Needs SKU link", tone: "bg-danger/15 text-danger" },
  needs_recipe: { label: "Needs recipe", tone: "bg-danger/15 text-danger" },
  canceled: { label: "Canceled", tone: "bg-line text-muted" },
  ignored: { label: "Not tracked", tone: "bg-line text-muted" },
};

export function ItemStateBadge({ state }: { state: ItemState }) {
  const s = ITEM_STATE[state];
  return <span className={clsx("inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap", s.tone)}>{s.label}</span>;
}

export const MARKET_LABEL: Record<string, string> = { US: "🇺🇸 US", CA: "🇨🇦 Canada" };

export type Channel = "amazon" | "shopify";
export const CHANNEL_LABEL: Record<string, string> = { amazon: "Amazon", shopify: "Shopify", manual: "Manual", api: "API" };

/** Where an order went: "Traverse City, MI" plus a flag for Canada. */
export function shipToShort(o: { shipCity: string | null; shipState: string | null; shipCountry: string | null }) {
  const place = [o.shipCity, o.shipState].filter(Boolean).join(", ");
  if (!place) return o.shipCountry ?? "—";
  return o.shipCountry && o.shipCountry !== "US" ? `${place} ${o.shipCountry === "CA" ? "🇨🇦" : o.shipCountry}` : place;
}

export type AddressLike = {
  name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  provinceCode: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
};

export function AddressBlock({ address }: { address: AddressLike | null | undefined }) {
  if (!address) return <span className="text-muted">—</span>;
  const lines = [
    address.name,
    address.company,
    address.address1,
    address.address2,
    [address.city, address.provinceCode ?? address.province, address.zip].filter(Boolean).join(" "),
    address.country,
    address.phone,
  ].filter(Boolean);
  return (
    <address className="not-italic leading-snug">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </address>
  );
}

/** Order amounts stay in the order's currency (CAD for Canada). */
export function formatPrice(n: number | null | undefined, currency: string | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(n);
}

/** Timestamps shown in factory (Michigan) time. */
export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Detroit",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Link an Amazon or Shopify SKU to a product, or mark it as not one of ours. */
export function SkuLinkForm({
  products,
  sku,
  source,
  compact,
}: {
  products: Product[];
  sku?: string;
  /** Fixed channel (a SKU from an order); otherwise the form asks. */
  source?: string;
  compact?: boolean;
}) {
  return (
    <ActionForm action={post("/api/channel-skus")} resetOnSuccess={!sku} className="flex flex-wrap items-end gap-2">
      {source ? (
        <input type="hidden" name="source" value={source} />
      ) : (
        <Field label="Channel">
          <Select name="source" defaultValue="amazon" className="w-32">
            <option value="amazon">Amazon</option>
            <option value="shopify">Shopify</option>
          </Select>
        </Field>
      )}
      {sku ? (
        <input type="hidden" name="sku" value={sku} />
      ) : (
        <Field label="SKU">
          <Input name="sku" required className="w-44" placeholder="e.g. LM-XL" />
        </Field>
      )}
      <Field label="Product">
        <Select name="productId" required defaultValue="" className="w-56">
          <option value="" disabled>
            Pick…
          </option>
          {products.map(({ product }) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
          <option value="ignore">Not a factory product</option>
        </Select>
      </Field>
      <Field label="Per unit" hint={compact ? undefined : "2 for a 2-pack"}>
        <Input name="qtyPerUnit" type="number" min="1" step="1" defaultValue={1} inputMode="numeric" className="w-20" />
      </Field>
      <SubmitButton variant="secondary">Link</SubmitButton>
    </ActionForm>
  );
}
