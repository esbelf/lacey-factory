import { todayInMichigan } from "@lacey-factory/shared/feet";

import { post, useApi } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import { Card, Empty, Field, formatDate, Input, PageHeader } from "../components/ui";
import { useCan } from "../me";
import { useTitle } from "../title";

export function SummitPage() {
  useTitle("Summit");
  const can = useCan();
  const stages = useApi("pipeline");
  const activity = useApi("activity");
  if (!stages.data || !activity.data) return <Loading error={stages.error ?? activity.error} />;

  const out = stages.data.filter((s) => s.atSummit > 0);
  const total = out.reduce((a, s) => a + s.atSummit, 0);
  const today = todayInMichigan();

  return (
    <>
      <PageHeader
        title="At Summit"
        subtitle={`${total} piece${total === 1 ? "" : "s"} out for sewing. When they come back, enter how many — the oldest sent are received first.`}
      />

      {out.length === 0 ? (
        <Card>
          <Empty>Nothing at Summit. Send cut pieces from the “To sew” page.</Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {out.map((s) => (
            <Card key={s.cutSizeId}>
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <div>
                  <div className="text-xl font-semibold">
                    {s.materialName} {s.label}
                  </div>
                  <div className="text-sm text-muted">oldest sent {formatDate(s.oldestSentToSummit)}</div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-semibold">{s.atSummit}</div>
                  <div className="text-sm text-muted">at Summit</div>
                </div>
              </div>
              <ActionForm action={post("/api/summit/receipts")} resetOnSuccess className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="cutSizeId" value={s.cutSizeId} />
                <Field label="Qty received">
                  <Input name="qty" type="number" min="1" max={s.atSummit} inputMode="numeric" className="w-24" required />
                </Field>
                <Field label="Received on">
                  <Input name="date" type="date" defaultValue={today} required />
                </Field>
                <SubmitButton>Receive</SubmitButton>
              </ActionForm>
            </Card>
          ))}
        </div>
      )}

      <Card title="Recent receipts from Summit" className="mt-6">
        {activity.data.receipts.length === 0 ? (
          <p className="text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {activity.data.receipts.map(({ receipt, label, materialName }) => (
              <li key={receipt.id} className="flex items-center gap-3 py-2">
                <div className="flex-1">
                  <div className="font-medium">
                    {receipt.qty} × {materialName} {label}
                  </div>
                  <div className="text-sm text-muted">
                    {formatDate(receipt.receivedOn)} · {receipt.createdBy}
                  </div>
                </div>
                {can("undo") && (
                  <ActionForm
                    action={post(`/api/summit/receipts/${receipt.id}/void`)}
                    confirm="Undo this receipt? Pieces go back to 'at Summit'."
                  >
                    <SubmitButton variant="ghost">Undo</SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
