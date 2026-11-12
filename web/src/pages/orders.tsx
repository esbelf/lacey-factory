import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";

import { type OrderFilters, type OrdersStatus, post, type Product, useApi, useOrders } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import {
  CHANNEL_LABEL,
  CostLine,
  formatDateTime,
  formatPrice,
  ItemStateBadge,
  MARKET_LABEL,
  shipToShort,
  SkuLinkForm,
} from "../components/orders-ui";
import { Card, Empty, Field, formatDate, Input, PageHeader, Select, Table } from "../components/ui";
import { useTitle } from "../title";

const STATUSES: Record<string, string[]> = {
  amazon: ["Pending", "Unshipped", "PartiallyShipped", "Shipped", "Canceled", "Unfulfillable"],
  shopify: ["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED"],
};
const MODE_LABEL: Record<string, string> = { off: "Off", fake: "Fake data", sandbox: "Sandbox", live: "Live" };

export function OrdersPage() {
  useTitle("Orders");
  const [params, setParams] = useSearchParams();
  const filters: OrderFilters = {
    source: params.get("source") ?? undefined,
    marketplace: params.get("marketplace") ?? undefined,
    status: params.get("status") ?? undefined,
    problems: params.get("problems") === "1",
    q: params.get("q") ?? undefined,
    before: params.get("before") ?? undefined,
  };
  const { data: status } = useApi("ordersStatus", { refetchInterval: 30_000 });
  const { data: products } = useApi("products");
  const { data, error, isFetching } = useOrders(filters);

  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete("before");
    if (name === "source") next.delete("status");
    setParams(next, { replace: true });
  }
  const statuses = filters.source ? STATUSES[filters.source] : [...STATUSES.amazon, ...STATUSES.shopify];

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle="Amazon (US and Canada) and the Shopify store. A paid order takes its steel, fabric and box out of inventory; a cancel or refund puts them back."
        action={
          <Link to="/customers" className="font-semibold text-brand">
            Customers →
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        {status && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <AmazonStatus status={status.amazon} />
            <ShopifyStatus status={status.shopify} />
            <ShipStationStatus status={status.shipstation} />
          </div>
        )}
        {status && products && <NeedsAttention status={status} products={products} />}

        <Card>
          <form
            className="mb-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter("q", String(new FormData(e.currentTarget).get("q") ?? "").trim());
            }}
          >
            <Field label="Channel">
              <Select value={filters.source ?? ""} onChange={(e) => setFilter("source", e.target.value)} className="w-36">
                <option value="">All</option>
                <option value="amazon">Amazon</option>
                <option value="shopify">Shopify</option>
              </Select>
            </Field>
            <Field label="Market">
              <Select value={filters.marketplace ?? ""} onChange={(e) => setFilter("marketplace", e.target.value)} className="w-36">
                <option value="">All</option>
                <option value="US">US</option>
                <option value="CA">Canada</option>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={filters.status ?? ""} onChange={(e) => setFilter("status", e.target.value)} className="w-48">
                <option value="">Any</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Search">
              <Input name="q" defaultValue={filters.q} placeholder="Order #, SKU, name or email" className="w-60" />
            </Field>
            <label className="flex h-11 items-center gap-2">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={!!filters.problems}
                onChange={(e) => setFilter("problems", e.target.checked ? "1" : "")}
              />
              Needs attention only
            </label>
            {isFetching && <span className="h-11 content-center text-sm text-muted">Loading…</span>}
          </form>

          {!data ? (
            <Loading error={error} />
          ) : data.orders.length === 0 ? (
            <Empty>
              {status?.amazon.mode === "off" && status.shopify.mode === "off"
                ? "No channel is connected yet (AMAZON_MODE and SHOPIFY_MODE are off)."
                : "No orders match."}
            </Empty>
          ) : (
            <OrdersTable orders={data.orders} />
          )}

          {data && (filters.before || data.more) && (
            <div className="mt-4 flex justify-between">
              {filters.before ? (
                <button type="button" className="font-semibold text-brand" onClick={() => setFilter("before", "")}>
                  ← Newest
                </button>
              ) : (
                <span />
              )}
              {data.more && (
                <button
                  type="button"
                  className="font-semibold text-brand"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.set("before", data.orders[data.orders.length - 1].purchasedAt);
                    setParams(next);
                  }}
                >
                  Older →
                </button>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function ChannelCard({ title, mode, children }: { title: string; mode: string; children: ReactNode }) {
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-lg font-bold">{title}</h2>
        <span className="rounded bg-line px-2 py-0.5 text-xs font-semibold">{MODE_LABEL[mode] ?? mode}</span>
      </div>
      <div className="flex flex-col gap-1 text-sm text-muted">{children}</div>
    </Card>
  );
}

function AmazonStatus({ status }: { status: OrdersStatus["amazon"] }) {
  const { mode, sync } = status;
  return (
    <ChannelCard title="Amazon" mode={mode}>
      {mode === "off" ? (
        <span>Set AMAZON_MODE in .env to start syncing.</span>
      ) : (
        <>
          <span>
            Checked every 15 minutes. Last synced {sync?.lastOkAt ? formatDateTime(sync.lastOkAt) : "never"}
            {sync?.cursor && <> · orders updated up to {formatDateTime(sync.cursor)}</>}
          </span>
          <ActionForm action={post("/api/orders/sync")} className="mt-2">
            <input type="hidden" name="source" value="amazon" />
            <SubmitButton variant="secondary">Sync now</SubmitButton>
          </ActionForm>
        </>
      )}
      {sync?.lastError && <span className="font-semibold text-danger">Last sync failed: {sync.lastError}</span>}
    </ChannelCard>
  );
}

function ShopifyStatus({ status }: { status: OrdersStatus["shopify"] }) {
  const { mode, sync, shop } = status;
  return (
    <ChannelCard title="Shopify" mode={mode}>
      {mode === "off" ? (
        <span>Set SHOPIFY_MODE in .env to receive orders.</span>
      ) : (
        <>
          <span>
            {shop} sends each paid order as it happens. Last webhook {sync?.lastEventAt ? formatDateTime(sync.lastEventAt) : "never"}
            {sync?.cursor && <> · last pull up to {formatDateTime(sync.cursor)}</>}
          </span>
          <ActionForm action={post("/api/orders/sync")} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="source" value="shopify" />
            <Field label="Since" hint={sync?.cursor ? "Empty: since the last pull" : "Empty: the last 30 days"}>
              <Input name="since" type="date" className="w-44" />
            </Field>
            <SubmitButton variant="secondary">Pull orders</SubmitButton>
          </ActionForm>
        </>
      )}
      {sync?.lastError && <span className="font-semibold text-danger">Last problem: {sync.lastError}</span>}
    </ChannelCard>
  );
}

function ShipStationStatus({ status }: { status: OrdersStatus["shipstation"] }) {
  const { mode, sync } = status;
  return (
    <ChannelCard title="ShipStation" mode={mode}>
      {mode === "off" ? (
        <span>Set SHIPSTATION_MODE in .env to get shipping costs.</span>
      ) : (
        <>
          <span>
            Sends each label as it&apos;s bought, with what it cost. Last webhook{" "}
            {sync?.lastEventAt ? formatDateTime(sync.lastEventAt) : "never"}
            {sync?.lastOkAt && <> · last re-check {formatDateTime(sync.lastOkAt)}</>}
          </span>
          <span>Voided labels don&apos;t send a webhook: re-check to drop them from the cost.</span>
          <ActionForm action={post("/api/orders/sync")} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="source" value="shipstation" />
            <Field label="Since" hint={sync?.cursor ? "Empty: since the last re-check" : "Empty: the last 30 days"}>
              <Input name="since" type="date" className="w-44" />
            </Field>
            <SubmitButton variant="secondary">Re-check shipments</SubmitButton>
          </ActionForm>
        </>
      )}
      {sync?.lastError && <span className="font-semibold text-danger">Last problem: {sync.lastError}</span>}
    </ChannelCard>
  );
}

function NeedsAttention({ status, products }: { status: OrdersStatus; products: Product[] }) {
  const { unmapped, noRecipe } = status.problems;
  if (!unmapped.length && !noRecipe.length) return null;
  return (
    <Card title="Needs attention" className="border-danger/40">
      {unmapped.length > 0 && (
        <>
          <p className="mb-3 text-sm text-muted">
            These SKUs aren&apos;t linked to a product, so their orders haven&apos;t taken anything from stock yet.
          </p>
          <ul className="divide-y divide-line">
            {unmapped.map((u) => (
              <li key={`${u.source}:${u.sku ?? "none"}`} className="flex flex-wrap items-end justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {u.sku ?? "(no SKU)"} <span className="text-sm font-normal text-muted">{CHANNEL_LABEL[u.source] ?? u.source}</span>
                  </div>
                  <div className="text-sm text-muted">
                    {u.title ?? "—"} · {u.orders} order{u.orders === 1 ? "" : "s"}
                  </div>
                </div>
                {u.sku && <SkuLinkForm products={products} sku={u.sku} source={u.source} compact />}
              </li>
            ))}
          </ul>
        </>
      )}
      {noRecipe.length > 0 && (
        <p className={unmapped.length ? "mt-4 border-t border-line pt-3" : ""}>
          No steel or fabric recipe yet for{" "}
          {noRecipe.map((p, i) => (
            <span key={p.productId ?? i}>
              {i > 0 && ", "}
              <strong>{p.productName}</strong> ({p.lines})
            </span>
          ))}
          . Set it under{" "}
          <Link to="/settings" className="font-semibold text-brand">
            Settings → Products
          </Link>{" "}
          and the orders will be recorded.
        </p>
      )}
    </Card>
  );
}

function OrdersTable({ orders }: { orders: NonNullable<ReturnType<typeof useOrders>["data"]>["orders"] }) {
  return (
    <Table>
      <thead>
        <tr>
          <th>Ordered</th>
          <th>Order</th>
          <th>Customer</th>
          <th>Ship to</th>
          <th>Status</th>
          <th>Items</th>
          <th>Shipped</th>
          <th className="text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id} className="align-top">
            <td className="whitespace-nowrap">{formatDateTime(o.purchasedAt)}</td>
            <td className="whitespace-nowrap">
              <Link to={`/orders/${o.id}`} className="font-semibold text-brand">
                {o.orderName ?? o.externalId}
              </Link>
              <div className="text-sm text-muted">
                {CHANNEL_LABEL[o.source] ?? o.source}
                {o.source === "amazon" && o.marketplace && <> · {MARKET_LABEL[o.marketplace] ?? o.marketplace}</>}
              </div>
            </td>
            <td>
              {o.customerId ? (
                <Link to={`/customers/${o.customerId}`} className="text-brand">
                  {o.customerName ?? o.email ?? "Customer"}
                </Link>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
            <td className="whitespace-nowrap">{shipToShort(o)}</td>
            <td>
              {o.status}
              {o.canceledAt && <div className="text-sm font-semibold text-danger">Canceled</div>}
            </td>
            <td>
              <ul className="flex flex-col gap-1">
                {o.items.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {i.qtyOrdered} × <span className="font-medium">{i.sku ?? "—"}</span>
                      {i.productName && <span className="text-muted"> → {i.productName}</span>}
                    </span>
                    <ItemStateBadge state={i.state} />
                    {i.state === "recorded" && i.steelCost != null && (
                      <span className="text-sm text-muted">
                        <CostLine c={i} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </td>
            <td className="whitespace-nowrap">
              {o.shippedOn ? formatDate(o.shippedOn) : <span className="text-muted">—</span>}
              {o.shippingCost != null && (
                <div className="text-sm text-muted">label {formatPrice(o.shippingCost, o.shippingCurrency)}</div>
              )}
            </td>
            <td className="text-right whitespace-nowrap">
              {formatPrice(o.orderTotal, o.currency)}
              {o.taxTotal != null && o.taxTotal > 0 && <div className="text-sm text-muted">tax {formatPrice(o.taxTotal, o.currency)}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
