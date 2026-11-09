import { Link, useSearchParams } from "react-router";

import { type CustomerRow, useCustomers } from "../api";
import { Loading } from "../components/loading";
import { formatDateTime, formatPrice } from "../components/orders-ui";
import { Card, Empty, Field, Input, PageHeader, Table } from "../components/ui";
import { useTitle } from "../title";

export const customerName = (c: { firstName: string | null; lastName: string | null; email: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unnamed customer";

/** "$1,234.00" or "$500.00 + CA$200.00" when they paid in more than one currency. */
export function formatSpent(spent: Record<string, number> | null) {
  if (!spent) return "—";
  return Object.entries(spent)
    .map(([currency, total]) => formatPrice(total, currency === "?" ? "USD" : currency))
    .join(" + ");
}

export function CustomersPage() {
  useTitle("Customers");
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const { data, error, isFetching } = useCustomers(q);

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={
          <>
            Everyone who has ordered from the Shopify store. A repeat buyer is one customer, matched by their Shopify account or email.{" "}
            <Link to="/orders" className="font-semibold text-brand">
              ← Orders
            </Link>
          </>
        }
      />
      <Card>
        <form
          className="mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = String(new FormData(e.currentTarget).get("q") ?? "").trim();
            setParams(value ? { q: value } : {}, { replace: true });
          }}
        >
          <Field label="Search">
            <Input name="q" defaultValue={q} placeholder="Name, email or phone" className="w-64" />
          </Field>
          {isFetching && <span className="h-11 content-center text-sm text-muted">Loading…</span>}
        </form>
        {!data ? (
          <Loading error={error} />
        ) : data.length === 0 ? (
          <Empty>{q ? "No customers match." : "No customers yet. They appear when Shopify orders come in."}</Empty>
        ) : (
          <CustomersTable rows={data} />
        )}
      </Card>
    </>
  );
}

function CustomersTable({ rows }: { rows: CustomerRow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>Email · phone</th>
          <th className="text-right">Orders</th>
          <th>First order</th>
          <th>Last order</th>
          <th className="text-right">Total spent</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ customer: c, orderCount, firstOrderAt, lastOrderAt, spent }) => (
          <tr key={c.id}>
            <td>
              <Link to={`/customers/${c.id}`} className="font-semibold text-brand">
                {customerName(c)}
              </Link>
              {orderCount > 1 && <span className="ml-2 rounded-full bg-brand/15 px-2 py-0.5 text-xs font-semibold text-brand-strong">Repeat</span>}
            </td>
            <td>
              <div>{c.email ?? "—"}</div>
              {c.phone && <div className="text-sm text-muted">{c.phone}</div>}
            </td>
            <td className="text-right">{orderCount}</td>
            <td className="whitespace-nowrap">{formatDateTime(firstOrderAt)}</td>
            <td className="whitespace-nowrap">{formatDateTime(lastOrderAt)}</td>
            <td className="text-right whitespace-nowrap">{formatSpent(spent)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
