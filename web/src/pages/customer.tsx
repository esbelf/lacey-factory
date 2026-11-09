import type { ReactNode } from "react";
import { Link, useParams } from "react-router";

import { useCustomer } from "../api";
import { Loading } from "../components/loading";
import { CHANNEL_LABEL, formatDateTime, formatPrice, shipToShort } from "../components/orders-ui";
import { Card, PageHeader, Table } from "../components/ui";
import { useTitle } from "../title";
import { customerName, formatSpent } from "./customers";

export function CustomerPage() {
  const { id = "" } = useParams();
  const { data, error } = useCustomer(id);
  useTitle(data ? customerName(data.customer) : "Customer");
  if (!data) return <Loading error={error} />;
  const { customer: c, orders, orderCount, firstOrderAt, lastOrderAt, spent } = data;

  return (
    <>
      <PageHeader
        title={customerName(c)}
        subtitle={
          <Link to="/customers" className="font-semibold text-brand">
            ← All customers
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        <Card>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            <Item label="Email">{c.email ?? "—"}</Item>
            <Item label="Phone">{c.phone ?? "—"}</Item>
            <Item label="Orders">{orderCount}</Item>
            <Item label="First order">{formatDateTime(firstOrderAt)}</Item>
            <Item label="Last order">{formatDateTime(lastOrderAt)}</Item>
            <Item label="Total spent (not counting canceled)">{formatSpent(spent)}</Item>
          </dl>
        </Card>

        <Card title="Orders">
          <Table>
            <thead>
              <tr>
                <th>Ordered</th>
                <th>Order</th>
                <th>Ship to</th>
                <th>Status</th>
                <th className="text-right">Items</th>
                <th className="text-right">Tax</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="whitespace-nowrap">{formatDateTime(o.purchasedAt)}</td>
                  <td>
                    <Link to={`/orders/${o.id}`} className="font-semibold text-brand">
                      {o.orderName ?? o.externalId}
                    </Link>
                    <span className="ml-2 text-sm text-muted">{CHANNEL_LABEL[o.source] ?? o.source}</span>
                  </td>
                  <td className="whitespace-nowrap">{shipToShort(o)}</td>
                  <td>
                    {o.status}
                    {o.canceledAt && <span className="ml-2 font-semibold text-danger">Canceled</span>}
                  </td>
                  <td className="text-right">{o.items}</td>
                  <td className="text-right">{formatPrice(o.taxTotal, o.currency)}</td>
                  <td className="text-right">{formatPrice(o.orderTotal, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
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
