import { todayInMichigan } from "@lacey-factory/shared/feet";

import { post, useApi } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import { Card, Empty, Field, formatDate, Input, PageHeader } from "../components/ui";
import { useCan } from "../me";
import { useTitle } from "../title";

export function ToSewPage() {
  useTitle("To sew");
  const can = useCan();
  const stages = useApi("pipeline");
  const activity = useApi("activity");
  if (!stages.data || !activity.data) return <Loading error={stages.error ?? activity.error} />;

  const waiting = stages.data.filter((s) => s.requiresSewing && s.cut > 0);
  const today = todayInMichigan();

  return (
    <>
      <PageHeader
        title="Cut material waiting to be sewn"
        subtitle="Oldest cut pieces are used first. Sewn in-house goes straight to inventory."
      />

      {waiting.length === 0 ? (
        <Card>
          <Empty>Nothing waiting. Cut pieces from a roll show up here.</Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {waiting.map((s) => (
            <Card key={s.cutSizeId}>
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <div>
                  <div className="text-xl font-semibold">
                    {s.materialName} {s.label}
                  </div>
                  <div className="text-sm text-muted">
                    {s.productFamily && `${s.productFamily} · `}oldest cut {formatDate(s.oldestCut)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-semibold">{s.cut}</div>
                  <div className="text-sm text-muted">waiting</div>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <ActionForm action={post("/api/sewing")} resetOnSuccess className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="cutSizeId" value={s.cutSizeId} />
                  <Field label="Qty">
                    <Input name="qty" type="number" min="1" max={s.cut} inputMode="numeric" className="w-20" required />
                  </Field>
                  <Field label="Sewn on">
                    <Input name="date" type="date" defaultValue={today} required />
                  </Field>
                  <SubmitButton>Sewn in-house</SubmitButton>
                </ActionForm>
                <ActionForm
                  action={post("/api/summit/shipments")}
                  resetOnSuccess
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="cutSizeId" value={s.cutSizeId} />
                  <Field label="Qty">
                    <Input name="qty" type="number" min="1" max={s.cut} inputMode="numeric" className="w-20" required />
                  </Field>
                  <Field label="Sent on">
                    <Input name="date" type="date" defaultValue={today} required />
                  </Field>
                  <SubmitButton variant="secondary">Send to Summit</SubmitButton>
                </ActionForm>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card title="Recent in-house sewing">
          <ActivityList
            items={activity.data.sews.map((b) => ({ id: b.id, date: b.sewnOn, by: b.createdBy, lines: b.lines }))}
            undoPath={can("undo") ? (id) => `/api/sewing/${id}/void` : undefined}
            confirm="Undo this sewing entry? Pieces go back to 'waiting to be sewn'."
          />
        </Card>
        <Card title="Recent shipments to Summit">
          <ActivityList
            items={activity.data.shipments.map((b) => ({ id: b.id, date: b.sentOn, by: b.createdBy, lines: b.lines }))}
            undoPath={can("undo") ? (id) => `/api/summit/shipments/${id}/void` : undefined}
            confirm="Undo this shipment? Pieces go back to 'waiting to be sewn'."
          />
        </Card>
      </div>
    </>
  );
}

function ActivityList({
  items,
  undoPath,
  confirm,
}: {
  items: { id: string; date: string; by: string; lines: { label: string; qty: number }[] }[];
  undoPath?: (id: string) => string;
  confirm: string;
}) {
  if (items.length === 0) return <p className="text-muted">None yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((i) => (
        <li key={i.id} className="flex items-center gap-3 py-2">
          <div className="flex-1">
            <div className="font-medium">{i.lines.map((l) => `${l.qty} × ${l.label}`).join(", ") || "—"}</div>
            <div className="text-sm text-muted">
              {formatDate(i.date)} · {i.by}
            </div>
          </div>
          {undoPath && (
            <ActionForm action={post(undoPath(i.id))} confirm={confirm}>
              <SubmitButton variant="ghost">Undo</SubmitButton>
            </ActionForm>
          )}
        </li>
      ))}
    </ul>
  );
}
