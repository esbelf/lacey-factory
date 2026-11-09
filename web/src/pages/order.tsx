import type { ReactNode } from "react";
import { Link, useParams } from "react-router";

import { type OrderDetail, useOrder } from "../api";
import { Loading } from "../components/loading";
import { AddressBlock, CHANNEL_LABEL, CostLine, formatDateTime, formatPrice, ItemStateBadge, MARKET_LABEL } from "../components/orders-ui";
import { Card, PageHeader, Table } from "../components/ui";
import { useTitle } from "../title";

export function OrderPage() {
  const { id = "" } = useParams();
  const { data: o, error } = useOrder(id);
  const number = o ? (o.orderName ?? o.externalId) : "";
  const channel = o ? (CHANNEL_LABEL[o.source] ?? o.source) : "";
  useTitle(o ? `${channel} order ${number}` : "Order");
  if (!o) return <Loading error={error} />;

  const money = (n: number | null) => formatPrice(n, o.currency);
  const isAmazon = o.source === "amazon";

  return (
    <>
      <PageHeader
        title={`${channel} order ${number}`}
        subtitle={
          <Link to="/orders" className="font-semibold text-brand">
            ← All orders
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Order" className="lg:col-span-2">
            {isAmazon ? <AmazonFacts o={o} /> : <ShopifyFacts o={o} />}
          </Card>
          <Card title="Money">
            <MoneyBreakdown o={o} />
          </Card>
        </div>

        {!isAmazon && (
          <div className="grid gap-4 md:grid-cols-3">
            <Card title="Customer">
              {o.customer ? (
                <div className="flex flex-col gap-1">
                  <Link to={`/customers/${o.customer.id}`} className="font-semibold text-brand">
                    {o.customer.name ?? o.customer.email ?? "Customer"}
                  </Link>
                  {o.customer.email && <span>{o.customer.email}</span>}
                  {o.customer.phone && <span>{o.customer.phone}</span>}
                  <span className="text-sm text-muted">
                    {o.customer.orderCount} order{o.customer.orderCount === 1 ? "" : "s"} in all
                  </span>
                </div>
              ) : (
                <span className="text-muted">{o.email ?? "No customer details"}</span>
              )}
            </Card>
            <Card title="Ship to">
              <AddressBlock address={o.shippingAddress} />
            </Card>
            <Card title="Bill to">
              <AddressBlock address={o.billingAddress} />
            </Card>
          </div>
        )}

        <Card title="Items">
          <Table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Price</th>
                <th className="text-right">Tax</th>
                {isAmazon && <th className="text-right">Shipping</th>}
                <th className="text-right">Discount</th>
                <th>Inventory</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((i) => (
                <tr key={i.id} className="align-top">
                  <td>
                    <div className="font-semibold">{i.sku ?? "—"}</div>
                    <div className="text-sm text-muted">{[i.asin, i.title].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>{i.productName ?? "—"}</td>
                  <td className="text-right">
                    {i.qtyOrdered}
                    {i.qtyShipped > 0 && <div className="text-sm text-muted">{i.qtyShipped} shipped</div>}
                  </td>
                  <td className="text-right">{money(i.itemPrice)}</td>
                  <td className="text-right">{money(i.itemTax)}</td>
                  {isAmazon && <td className="text-right">{money(i.shippingPrice)}</td>}
                  <td className="text-right">{money(i.promotionDiscount)}</td>
                  <td>
                    <ItemStateBadge state={i.state} />
                    {i.problem && <div className="mt-1 text-sm text-danger">{i.problem}</div>}
                    {i.state === "recorded" && i.steelCost != null && (
                      <div className="mt-1 text-sm text-muted">
                        <CostLine c={i} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title={`Everything ${channel} sent`}>
          <details>
            <summary className="cursor-pointer font-semibold text-brand">Show raw order data</summary>
            <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-canvas p-3 text-xs">
              {JSON.stringify(isAmazon ? { order: o.raw, items: o.items.map((i) => i.raw) } : o.raw, null, 2)}
            </pre>
          </details>
        </Card>
      </div>
    </>
  );
}

function AmazonFacts({ o }: { o: OrderDetail }) {
  const shipTo = [o.shipCity, o.shipState, o.shipPostalCode, o.shipCountry].filter(Boolean).join(", ");
  const yes = (b: boolean) => (b ? "Yes" : "No");
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      <Item label="Market">
        {MARKET_LABEL[o.marketplace ?? ""] ?? o.marketplace ?? "—"} · {o.salesChannel ?? "—"}
      </Item>
      <Item label="Amazon status">{o.status}</Item>
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
  );
}

function ShopifyFacts({ o }: { o: OrderDetail }) {
  const units = o.items.reduce((s, i) => s + i.qtyOrdered, 0);
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      <Item label="Ordered">{formatDateTime(o.purchasedAt)}</Item>
      <Item label="Payment">
        {o.status}
        {o.canceledAt && <span className="ml-2 font-semibold text-danger">Canceled {formatDateTime(o.canceledAt)}</span>}
      </Item>
      <Item label="Fulfillment">{o.fulfillmentStatus ?? "—"}</Item>
      <Item label="Order size">
        {units} item{units === 1 ? "" : "s"} · {o.items.length} line{o.items.length === 1 ? "" : "s"}
      </Item>
      <Item label="Shipping method">{o.shipServiceLevel ?? "—"}</Item>
      <Item label="Sold through">{o.salesChannel ?? "—"}</Item>
      <Item label="Email">{o.email ?? "—"}</Item>
      <Item label="Phone">{o.phone ?? "—"}</Item>
      <Item label="Last updated by Shopify">{formatDateTime(o.lastUpdatedAt)}</Item>
      <Item label="First seen · last saved">
        {formatDateTime(o.firstSeenAt)} · {formatDateTime(o.syncedAt)}
      </Item>
    </dl>
  );
}

/** Subtotal, discounts, shipping the customer paid, each tax, total. */
function MoneyBreakdown({ o }: { o: OrderDetail }) {
  const money = (n: number | null) => formatPrice(n, o.currency);
  const row = (label: ReactNode, value: ReactNode, strong = false) => (
    <div className={`flex justify-between gap-4 ${strong ? "border-t border-line pt-2 font-bold" : ""}`}>
      <dt>{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
  if (o.source === "amazon") {
    const sum = (k: "itemPrice" | "itemTax" | "shippingPrice" | "promotionDiscount") =>
      o.items.reduce((s, i) => s + (i[k] ?? 0), 0);
    return (
      <dl className="flex flex-col gap-2">
        {row("Items", money(sum("itemPrice")))}
        {row("Shipping charged", money(sum("shippingPrice")))}
        {row("Discounts", money(-sum("promotionDiscount")))}
        {row("Tax", money(sum("itemTax")))}
        {row("Total", money(o.orderTotal), true)}
      </dl>
    );
  }
  return (
    <dl className="flex flex-col gap-2">
      {row("Items", money(o.subtotal))}
      {o.discountTotal ? row("Discounts", money(-o.discountTotal)) : null}
      {row("Shipping charged", money(o.shippingCharged))}
      {o.taxLines?.length
        ? o.taxLines.map((t, i) => (
            <div key={i}>{row(`${t.title}${t.rate != null ? ` (${+(t.rate * 100).toFixed(3)}%)` : ""}`, money(t.amount))}</div>
          ))
        : row("Tax", money(o.taxTotal ?? 0))}
      {row("Total", money(o.orderTotal), true)}
      <p className="mt-2 text-sm text-muted">Shipping cost (what we pay the carrier) will come from ShipStation.</p>
    </dl>
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
