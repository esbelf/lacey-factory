import { todayInMichigan } from "@lacey-factory/shared/feet";
import { formatMoney, sumMoney } from "@lacey-factory/shared/money";
import clsx from "clsx";

import { post, type Product, type SaleRow, type SteelData, useApi } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import { Card, Empty, Field, formatDate, Input, PageHeader, Select, Table } from "../components/ui";
import { useCan } from "../me";
import { useTitle } from "../title";

const REASONS = {
  opening_balance: "Opening balance",
  count_correction: "Count correction",
  sale: "Sale / shipped",
  other: "Other",
} as const;

const LOT_SOURCE = { invoice: "Invoice", opening_balance: "Opening balance", count_correction: "Count correction" } as const;
const SALE_SOURCE = { manual: "Entered by hand", shopify: "Shopify", amazon: "Amazon", api: "API" } as const;

const negative = (n: number) => clsx(n < 0 && "text-danger");

export function InventoryPage() {
  useTitle("Inventory");
  const can = useCan();
  const stagesQ = useApi("pipeline");
  const adjustmentsQ = useApi("adjustments");
  const steelQ = useApi("steel");
  const salesQ = useApi("sales");
  const productsQ = useApi("products");
  if (!stagesQ.data || !adjustmentsQ.data || !steelQ.data || !salesQ.data || !productsQ.data) {
    return <Loading error={stagesQ.error ?? adjustmentsQ.error ?? steelQ.error ?? salesQ.error ?? productsQ.error} />;
  }

  const stages = stagesQ.data;
  const adjustments = adjustmentsQ.data;
  const rows = stages.filter((s) => s.active || s.onHand || s.cut || s.atSummit);
  const totals = rows.reduce(
    (a, s) => ({ cut: a.cut + s.cut, summit: a.summit + s.atSummit, onHand: a.onHand + s.onHand }),
    { cut: 0, summit: 0, onHand: 0 },
  );

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Sewn fabric by size and steel poles on hand. Each sale takes out the fabric and steel its product uses."
      />

      <Card title="Fabric">
        {rows.length === 0 ? (
          <Empty>No sizes yet. Set them up in Settings.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Material</th>
                <th>Size</th>
                <th>Used for</th>
                <th className="text-right">Cut, not sewn</th>
                <th className="text-right">At Summit</th>
                <th className="text-right">On hand</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.cutSizeId}>
                  <td>{s.materialName}</td>
                  <td className="font-semibold">{s.label}</td>
                  <td className="text-muted">{s.productFamily ?? "—"}</td>
                  <td className="text-right">{s.requiresSewing ? s.cut : "—"}</td>
                  <td className="text-right">{s.requiresSewing ? s.atSummit : "—"}</td>
                  <td className={clsx("text-right text-xl font-semibold", negative(s.onHand))}>{s.onHand}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={3}>Total</td>
                <td className="text-right">{totals.cut}</td>
                <td className="text-right">{totals.summit}</td>
                <td className="text-right text-xl">{totals.onHand}</td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>

      <SteelTable items={steelQ.data.items} />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {can("sales:record") && <RecordSale products={productsQ.data} />}
        <RecentSales sales={salesQ.data} canUndo={can("sales:record")} />

        {can("inventory:adjust") && <AdjustSteel items={steelQ.data.items} />}
        <RecentSteel data={steelQ.data} />

        {can("inventory:adjust") && (
          <Card title="Adjust fabric">
            <p className="mb-3 text-sm text-muted">
              Use for the opening count when we switch off Katana, and for corrections after a physical count. Use a
              negative number to remove stock.
            </p>
            <ActionForm action={post("/api/inventory/adjustments")} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
              <Field label="Size">
                <Select name="cutSizeId" required defaultValue="">
                  <option value="" disabled>
                    Pick a size
                  </option>
                  {stages.map((s) => (
                    <option key={s.cutSizeId} value={s.cutSizeId}>
                      {s.materialName} {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Change (+/−)">
                <Input name="qty" type="number" step="1" inputMode="numeric" required />
              </Field>
              <Field label="Reason">
                <Select name="reason" defaultValue="count_correction">
                  {Object.entries(REASONS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date">
                <Input name="adjustedOn" type="date" defaultValue={todayInMichigan()} required />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Note">
                  <Input name="note" placeholder="e.g. Nov 1 physical count" />
                </Field>
              </div>
              <div>
                <SubmitButton>Save adjustment</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        )}

        <Card title="Recent fabric adjustments">
          {adjustments.length === 0 ? (
            <p className="text-muted">None yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {adjustments.map(({ adj, label, materialName }) => (
                <li key={adj.id} className="py-2">
                  <div className="font-medium">
                    {adj.qty > 0 ? "+" : ""}
                    {adj.qty} × {materialName} {label} · {REASONS[adj.reason]}
                  </div>
                  <div className="text-sm text-muted">
                    {formatDate(adj.adjustedOn)} · {adj.createdBy}
                    {adj.note && ` · ${adj.note}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function SteelTable({ items }: { items: SteelData["items"] }) {
  const shown = items.filter((i) => i.active || i.onHand !== 0);
  return (
    <Card title="Steel poles" className="mt-6">
      {shown.length === 0 ? (
        <Empty>No steel items yet. Add them under Settings → Steel poles.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Pole</th>
              <th className="text-right">Latest cost / pole</th>
              <th className="text-right">Value on hand</th>
              <th className="text-right">On hand</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.id}>
                <td className="font-semibold">{i.name}</td>
                <td className="text-right text-muted">{formatMoney(i.latestCost)}</td>
                <td className="text-right">{formatMoney(i.value)}</td>
                <td className={clsx("text-right text-xl font-semibold", negative(i.onHand))}>{i.onHand}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td colSpan={2}>Total</td>
              <td className="text-right">{formatMoney(sumMoney(shown.map((i) => i.value)))}</td>
              <td className="text-right text-xl">{shown.reduce((a, i) => a + i.onHand, 0)}</td>
            </tr>
          </tbody>
        </Table>
      )}
      <p className="mt-3 text-sm text-muted">
        Cost includes each invoice&apos;s freight, spread over its lines. Sales use the oldest poles first. A red number
        means more was sold than we had recorded; the next delivery fills it in.
      </p>
    </Card>
  );
}

function recipe(p: Product) {
  return [...p.steel.map((s) => `${s.qty} × ${s.name}`), ...p.uses.map((u) => `${u.qty} × ${u.material} ${u.label}`)].join(" + ");
}

function RecordSale({ products }: { products: Product[] }) {
  const sellable = products.filter((p) => p.product.active && (p.steel.length || p.uses.length));
  return (
    <Card title="Record a sale">
      <p className="mb-3 text-sm text-muted">
        Takes the product&apos;s steel and fabric out of inventory. Shopify and Amazon orders will be recorded
        automatically later; use this for anything else.
      </p>
      {sellable.length === 0 ? (
        <p className="text-muted">No products have a recipe yet. Set them up under Settings → Products.</p>
      ) : (
        <ActionForm action={post("/api/sales")} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Product">
              <Select name="productId" required defaultValue="">
                <option value="" disabled>
                  Pick a product
                </option>
                {sellable.map((p) => (
                  <option key={p.product.id} value={p.product.id}>
                    {p.product.name} — {recipe(p)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Quantity">
            <Input name="qty" type="number" step="1" min="1" defaultValue={1} inputMode="numeric" required />
          </Field>
          <Field label="Sold on">
            <Input name="soldOn" type="date" defaultValue={todayInMichigan()} required />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Note">
              <Input name="note" placeholder="e.g. dealer order #" />
            </Field>
          </div>
          <div>
            <SubmitButton>Record sale</SubmitButton>
          </div>
        </ActionForm>
      )}
    </Card>
  );
}


function RecentSales({ sales, canUndo }: { sales: SaleRow[]; canUndo: boolean }) {
  return (
    <Card title="Recent sales">
      {sales.length === 0 ? (
        <p className="text-muted">None yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {sales.map(({ sale, productName }) => (
            <li key={sale.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {sale.qty} × {productName} · steel {formatMoney(sale.steelCost)}
                  {sale.short && <span className="ml-2 text-sm font-semibold text-danger">steel short</span>}
                </div>
                <div className="text-sm text-muted">
                  {formatDate(sale.soldOn)} · {SALE_SOURCE[sale.source]}
                  {sale.externalRef && ` #${sale.externalRef}`}
                  {sale.note && ` · ${sale.note}`}
                </div>
              </div>
              {canUndo && (
                <ActionForm action={post(`/api/sales/${sale.id}/void`)} confirm="Undo this sale? Its steel and fabric go back into inventory.">
                  <SubmitButton variant="ghost">Undo</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AdjustSteel({ items }: { items: SteelData["items"] }) {
  const active = items.filter((i) => i.active);
  return (
    <Card title="Adjust steel">
      <p className="mb-3 text-sm text-muted">
        For the opening count and corrections after a physical count. Adding poles needs their cost per pole; removing
        takes from the oldest poles.
      </p>
      {active.length === 0 ? (
        <p className="text-muted">Add steel items under Settings first.</p>
      ) : (
        <ActionForm action={post("/api/steel/adjustments")} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
          <Field label="Pole">
            <Select name="steelItemId" required defaultValue="">
              <option value="" disabled>
                Pick a pole
              </option>
              {active.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Change (+/−)">
            <Input name="qty" type="number" step="1" inputMode="numeric" required />
          </Field>
          <Field label="Cost per pole ($)" hint="Only when adding">
            <Input name="unitCost" type="number" step="0.0001" min="0" inputMode="decimal" />
          </Field>
          <Field label="Reason">
            <Select name="reason" defaultValue="count_correction">
              <option value="opening_balance">Opening balance</option>
              <option value="count_correction">Count correction</option>
            </Select>
          </Field>
          <Field label="Date">
            <Input name="adjustedOn" type="date" defaultValue={todayInMichigan()} required />
          </Field>
          <Field label="Note">
            <Input name="note" placeholder="e.g. Nov 1 physical count" />
          </Field>
          <div>
            <SubmitButton>Save adjustment</SubmitButton>
          </div>
        </ActionForm>
      )}
    </Card>
  );
}

function RecentSteel({ data }: { data: SteelData }) {
  const entries = [
    ...data.lots.map(({ lot, name }) => ({
      id: lot.id,
      at: lot.createdAt,
      title: `+${lot.qty} × ${name} · ${LOT_SOURCE[lot.source]}${lot.invoiceNumber ? ` #${lot.invoiceNumber}` : ""}`,
      detail: `${formatDate(lot.receivedOn)} · ${formatMoney(lot.landedUnitCost)}/pole${
        lot.freightPerUnit ? ` (incl. ${formatMoney(lot.freightPerUnit)} freight)` : ""
      } · ${lot.qtyRemaining} left${lot.note && lot.source !== "invoice" ? ` · ${lot.note}` : ""}`,
    })),
    ...data.removals.map(({ usage, name }) => ({
      id: usage.id,
      at: usage.createdAt,
      title: `−${usage.qty} × ${name} · Count correction`,
      detail: `${formatDate(usage.usedOn)} · ${usage.createdBy}${usage.note ? ` · ${usage.note}` : ""}`,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <Card title="Recent steel">
      {entries.length === 0 ? (
        <p className="text-muted">None yet. Steel invoices emailed by a steel supplier show up here.</p>
      ) : (
        <ul className="divide-y divide-line">
          {entries.slice(0, 25).map((e) => (
            <li key={e.id} className="py-2">
              <div className="font-medium">{e.title}</div>
              <div className="text-sm text-muted">{e.detail}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
