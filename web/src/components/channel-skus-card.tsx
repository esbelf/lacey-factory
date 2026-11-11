import { type ChannelSkuRow, post, type Product } from "../api";
import { ActionForm, SubmitButton } from "./action-form";
import { CHANNEL_LABEL, SkuLinkForm } from "./orders-ui";
import { SectionHeader } from "./settings-ui";
import { Empty } from "./ui";

/** Settings → Channel SKUs: which product each Amazon or Shopify SKU is. */
export function ChannelSkusCard({ skus, products }: { skus: ChannelSkuRow[]; products: Product[] }) {
  return (
    <>
      <SectionHeader title="Amazon and Shopify SKUs">
        Which product each store SKU is. Orders for a SKU that isn&apos;t linked wait under Orders, in Needs attention.
        Linking a SKU again changes it for new orders only.
      </SectionHeader>
      {skus.length === 0 ? (
        <div className="p-6">
          <Empty>No SKUs linked yet. Link the first one below.</Empty>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs text-muted">
                <th className="w-24 px-4 py-2 font-medium sm:pl-6">Store</th>
                <th className="px-4 py-2 font-medium">SKU</th>
                <th className="px-4 py-2 font-medium">Product</th>
                <th className="w-24 px-4 py-2 sm:pr-6">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="[&_td]:border-t [&_td]:border-line">
              {skus.map(({ sku, productName }) => (
                <tr key={sku.id}>
                  <td className="px-4 py-2 text-sm text-muted sm:pl-6">{CHANNEL_LABEL[sku.source] ?? sku.source}</td>
                  <td className="px-4 py-2 font-semibold tabular-nums">{sku.sku}</td>
                  <td className="px-4 py-2">
                    {sku.productId ? (
                      <>
                        {sku.qtyPerUnit > 1 && <span className="tabular-nums">{sku.qtyPerUnit} × </span>}
                        {productName}
                      </>
                    ) : (
                      <span className="text-muted">Not a factory product</span>
                    )}
                  </td>
                  <td className="px-4 py-1 text-right sm:pr-6">
                    <ActionForm action={post(`/api/channel-skus/${sku.id}/delete`)} confirm={`Remove the link for ${sku.sku}?`}>
                      <SubmitButton variant="ghost">Remove</SubmitButton>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="border-t border-line px-4 py-4 sm:px-6">
        <h3 className="mb-2 font-semibold">Link a SKU</h3>
        <SkuLinkForm products={products} />
      </div>
    </>
  );
}
