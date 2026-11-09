import { type ChannelSkuRow, post, type Product } from "../api";
import { ActionForm, SubmitButton } from "./action-form";
import { CHANNEL_LABEL, SkuLinkForm } from "./orders-ui";
import { Card, Empty } from "./ui";

/** Settings → Channel SKUs: which product each Amazon or Shopify SKU is. */
export function ChannelSkusCard({ skus, products }: { skus: ChannelSkuRow[]; products: Product[] }) {
  return (
    <Card title="Amazon and Shopify SKUs">
      <p className="mb-3 text-sm text-muted">
        Which product each Amazon or Shopify SKU is. Orders for a SKU that isn&apos;t linked wait under Orders → Needs attention.
        Linking the same SKU again changes it for new orders only.
      </p>
      {skus.length === 0 ? (
        <Empty>No SKUs linked yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {skus.map(({ sku, productName }) => (
            <li key={sku.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span>
                <span className="mr-2 rounded bg-line px-1.5 py-0.5 text-xs font-semibold">{CHANNEL_LABEL[sku.source] ?? sku.source}</span>
                <span className="font-semibold">{sku.sku}</span> →{" "}
                {sku.productId ? (
                  <>
                    {sku.qtyPerUnit > 1 && `${sku.qtyPerUnit} × `}
                    {productName}
                  </>
                ) : (
                  <span className="text-muted">not a factory product</span>
                )}
              </span>
              <ActionForm action={post(`/api/channel-skus/${sku.id}/delete`)} confirm={`Remove the link for ${sku.sku}?`}>
                <SubmitButton variant="ghost">Remove</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 border-t border-line pt-4">
        <SkuLinkForm products={products} />
      </div>
    </Card>
  );
}
