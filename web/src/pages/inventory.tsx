import { todayInMichigan } from "@lacey-factory/shared/feet";

import { post, useApi } from "../api";
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

export function InventoryPage() {
  useTitle("Inventory");
  const can = useCan();
  const stagesQ = useApi("pipeline");
  const adjustmentsQ = useApi("adjustments");
  if (!stagesQ.data || !adjustmentsQ.data) return <Loading error={stagesQ.error ?? adjustmentsQ.error} />;

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
        subtitle="Sewn material by size, ready for any product that uses it (e.g. LakeMat or MuckMat)."
      />

      <Card>
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
                  <td className="text-right text-xl font-semibold">{s.onHand}</td>
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

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {can("inventory:adjust") && (
          <Card title="Adjust inventory">
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

        <Card title="Recent adjustments">
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
