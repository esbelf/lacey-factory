import { formatMoney } from "@lacey-factory/shared/money";
import { Link, useSearchParams } from "react-router";

import { type OrderFilters, type OrdersStatus, post, type Product, useApi, useOrders } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import { formatDateTime, formatPrice, ItemStateBadge, MARKET_LABEL, SkuLinkForm } from "../components/orders-ui";
import { Card, Empty, Field, Input, PageHeader, Select, Table } from "../components/ui";
import { useTitle } from "../title";

const STATUSES = ["Pending", "Unshipped", "PartiallyShipped", "Shipped", "Canceled", "Unfulfillable"];
const MODE_LABEL = { off: "Off", fake: "Fake orders", sandbox: "Amazon sandbox", live: "Live" } as const;

export function OrdersPage() {
  useTitle("Orders");
  const [params, setParams] = useSearchParams();
  const filters: OrderFilters = {
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
    setParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle="Amazon US and Canada. A paid order takes its steel and fabric out of inventory; a cancel puts them back."
        action={
          status && status.mode !== "off" ? (
            <ActionForm action={post("/api/orders/sync")}>
              <SubmitButton variant="secondary">Sync now</SubmitButton>
            </ActionForm>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        {status && <SyncStatus status={status} />}
        {status && products && <NeedsAttention status={status} products={products} />}

        <Card>
          <form
            className="mb-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter("q", String(new FormData(e.currentTarget).get("q") ?? "").trim());
            }}
          >
            <Field label="Market">
              <Select value={filters.marketplace ?? ""} onChange={(e) => setFilter("marketplace", e.target.value)} className="w-36">
                <option value="">All</option>
                <option value="US">US</option>
                <option value="CA">Canada</option>
              </Select>
            </Field>
            <Field label="Amazon status">
              <Select value={filters.status ?? ""} onChange={(e) => setFilter("status", e.target.value)} className="w-44">
                <option value="">Any</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Search">
              <Input name="q" defaultValue={filters.q} placeholder="Order # or SKU" className="w-52" />
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
            <Empty>{status?.mode === "off" ? "Amazon isn't connected yet (AMAZON_MODE=off)." : "No orders match."}</Empty>
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

function SyncStatus({ status }: { status: OrdersStatus }) {
  const { mode, sync } = status;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      <span className="rounded bg-line px-2 py-0.5 font-semibold text-ink">{MODE_LABEL[mode]}</span>
      {mode === "off" ? (
        <span>Set AMAZON_MODE in .env to start syncing.</span>
      ) : (
        <>
          <span>Last synced {sync?.lastOkAt ? formatDateTime(sync.lastOkAt) : "never"}</span>
          {sync?.cursor && <span>· orders updated up to {formatDateTime(sync.cursor)}</span>}
        </>
      )}
      {sync?.lastError && <span className="w-full font-semibold text-danger">Last sync failed: {sync.lastError}</span>}
    </div>
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
            These Amazon SKUs aren&apos;t linked to a product, so their orders haven&apos;t taken anything from stock yet.
          </p>
          <ul className="divide-y divide-line">
            {unmapped.map((u) => (
              <li key={u.sku ?? "none"} className="flex flex-wrap items-end justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="font-semibold">{u.sku ?? "(no SKU)"}</div>
                  <div className="text-sm text-muted">
                    {u.title ?? "—"} · {u.orders} order{u.orders === 1 ? "" : "s"}
                  </div>
                </div>
                {u.sku && <SkuLinkForm products={products} sku={u.sku} compact />}
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
          <th>Market</th>
          <th>Status</th>
          <th>Items</th>
          <th className="text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id} className="align-top">
            <td className="whitespace-nowrap">{formatDateTime(o.purchasedAt)}</td>
            <td className="whitespace-nowrap">
              <Link to={`/orders/${o.id}`} className="font-semibold text-brand">
                {o.externalId}
              </Link>
            </td>
            <td className="whitespace-nowrap">{MARKET_LABEL[o.marketplace ?? ""] ?? o.marketplace ?? "—"}</td>
            <td>{o.status}</td>
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
                        steel {formatMoney(i.steelCost)}
                        {i.short && <span className="ml-1 font-semibold text-danger">short</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </td>
            <td className="text-right whitespace-nowrap">{formatPrice(o.orderTotal, o.currency)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
