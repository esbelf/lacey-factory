import { formatMoney } from "@lacey-factory/shared/money";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";

import { useOrder } from "../api";
import { Loading } from "../components/loading";
import { formatDateTime, formatPrice, ItemStateBadge, MARKET_LABEL } from "../components/orders-ui";
import { Card, PageHeader, Table } from "../components/ui";
import { useTitle } from "../title";

export function OrderPage() {
  const { id = "" } = useParams();
  const { data: o, error } = useOrder(id);
  useTitle(o ? `Order ${o.externalId}` : "Order");
  if (!o) return <Loading error={error} />;

  const money = (n: number | null) => formatPrice(n, o.currency);
  const shipTo = [o.shipCity, o.shipState, o.shipPostalCode, o.shipCountry].filter(Boolean).join(", ");
  const yes = (b: boolean) => (b ? "Yes" : "No");

  return (
    <>
      <PageHeader
        title={`Order ${o.externalId}`}
        subtitle={
          <Link to="/orders" className="font-semibold text-brand">
            ← All orders
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        <Card title="Order">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <Item label="Market">
              {MARKET_LABEL[o.marketplace ?? ""] ?? o.marketplace ?? "—"} · {o.salesChannel ?? "—"}
            </Item>
            <Item label="Amazon status">{o.status}</Item>
            <Item label="Total">{money(o.orderTotal)}</Item>
            <Item label="Ordered">{formatDateTime(o.purchasedAt)}</Item>
            <Item label="Last updated by Amazon">{formatDateTime(o.lastUpdatedAt)}</Item>
            <Item label="Ship by">{formatDateTime(o.latestShipDate)}</Item>
            <Item label="Deliver by">{formatDateTime(o.latestDeliveryDate)}</Item>
            <Item label="Fulfillment">{o.fulfillmentChannel === "MFN" ? "We ship (FBM)" : (o.fulfillmentChannel ?? "—")}</Item>
            <Item label="Shipping service">{o.shipServiceLevel ?? "—"}</Item>
            <Item label="Ship to">{shipTo || "—"}</Item>
            <Item label="Items shipped / unshipped">
              {o.itemsShipped ?? "—"} / {o.itemsUnshipped ?? "—"}
            </Item>
            <Item label="Order type">{o.orderType ?? "—"}</Item>
            <Item label="Payment">{o.paymentMethod ?? "—"}</Item>
            <Item label="Prime · Business · Replacement">
              {yes(o.isPrime)} · {yes(o.isBusiness)} · {yes(o.isReplacement)}
            </Item>
            <Item label="First seen · last synced">
              {formatDateTime(o.firstSeenAt)} · {formatDateTime(o.syncedAt)}
            </Item>
          </dl>
        </Card>

        <Card title="Items">
          <Table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Price</th>
                <th className="text-right">Tax</th>
                <th className="text-right">Shipping</th>
                <th className="text-right">Discount</th>
                <th>Inventory</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((i) => (
                <tr key={i.id} className="align-top">
                  <td>
                    <div className="font-semibold">{i.sku ?? "—"}</div>
                    <div className="text-sm text-muted">
                      {i.asin} · {i.title}
                    </div>
                  </td>
                  <td>{i.productName ?? "—"}</td>
                  <td className="text-right">
                    {i.qtyOrdered}
                    {i.qtyShipped > 0 && <div className="text-sm text-muted">{i.qtyShipped} shipped</div>}
                  </td>
                  <td className="text-right">{money(i.itemPrice)}</td>
                  <td className="text-right">{money(i.itemTax)}</td>
                  <td className="text-right">{money(i.shippingPrice)}</td>
                  <td className="text-right">{money(i.promotionDiscount)}</td>
                  <td>
                    <ItemStateBadge state={i.state} />
                    {i.problem && <div className="mt-1 text-sm text-danger">{i.problem}</div>}
                    {i.state === "recorded" && i.steelCost != null && (
                      <div className="mt-1 text-sm text-muted">
                        Steel {formatMoney(i.steelCost)} · box {formatMoney(i.boxCost)}
                        {i.short && <span className="ml-1 font-semibold text-danger">(short)</span>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Everything Amazon sent">
          <details>
            <summary className="cursor-pointer font-semibold text-brand">Show raw order data</summary>
            <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-canvas p-3 text-xs">
              {JSON.stringify({ order: o.raw, items: o.items.map((i) => i.raw) }, null, 2)}
            </pre>
          </details>
        </Card>
      </div>
    </>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
