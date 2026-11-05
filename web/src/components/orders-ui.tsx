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

/** Link an Amazon SKU to a product, or mark it as not one of ours. */
export function SkuLinkForm({ products, sku, compact }: { products: Product[]; sku?: string; compact?: boolean }) {
  return (
    <ActionForm action={post("/api/channel-skus")} resetOnSuccess={!sku} className="flex flex-wrap items-end gap-2">
      {sku ? (
        <input type="hidden" name="sku" value={sku} />
      ) : (
        <Field label="Amazon SKU">
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
