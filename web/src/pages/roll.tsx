import { formatFeet, subtractFeet, todayInMichigan } from "@lacey-factory/shared/feet";
import { formatMoney } from "@lacey-factory/shared/money";
import { useParams } from "react-router";

import { documentFileUrl, patch, post, useRoll } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { CutForm } from "../components/cut-form";
import { Loading } from "../components/loading";
import { Card, Empty, Field, formatDate, Input, PageHeader, StatusBadge, Table } from "../components/ui";
import { useCan } from "../me";
import { useTitle } from "../title";
import { NotFoundPage } from "./not-found";

export function RollPage() {
  const { id = "" } = useParams();
  const { data, error } = useRoll(id);
  const can = useCan();
  useTitle(data ? data.roll.appCode : "Roll");

  if (error?.status === 404) return <NotFoundPage />;
  if (!data) return <Loading error={error} />;

  const { roll, material, sessions, totals, sizes, usedFt, remainingFt, status } = data;
  const today = todayInMichigan();
  const drift = roll.leftoverFtMeasured != null ? subtractFeet(remainingFt, roll.leftoverFtMeasured) : null;

  return (
    <>
      <PageHeader
        title={`${roll.appCode} · ${material.name}`}
        subtitle={
          <>
            {roll.supplierRollNo && <>Supplier #{roll.supplierRollNo} · </>}
            {roll.supplier && <>{roll.supplier} · </>}
            Received {formatDate(roll.receivedOn)} · {formatFeet(roll.widthFt)} × {formatFeet(roll.lengthFt)}
          </>
        }
        action={<StatusBadge status={status} />}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          {status !== "closed" ? (
            <Card title="Record a cut">
              <CutForm
                rollId={roll.id}
                remainingFt={remainingFt}
                today={today}
                canEditSettings={can("settings")}
                sizes={sizes.map((s) => ({
                  id: s.id,
                  label: s.label,
                  cutLengthFt: s.cutLengthFt,
                  productFamily: s.productFamily,
                }))}
              />
            </Card>
          ) : (
            <Card title="Roll closed">
              <p>
                Closed {formatDate(roll.closedOn)}.{" "}
                {roll.leftoverFtMeasured == null ? (
                  <>{formatFeet(remainingFt)} left by our count</>
                ) : (
                  <>
                    Measured leftover {formatFeet(roll.leftoverFtMeasured)} vs {formatFeet(remainingFt)} computed
                  </>
                )}
                {drift != null && drift !== 0 && (
                  <>
                    {" "}
                    — {formatFeet(Math.abs(drift))} {drift > 0 ? "less than expected (cut long / waste)" : "more than expected"}
                  </>
                )}
                .
              </p>
              {can("rolls:close") && (
                <ActionForm action={post(`/api/rolls/${roll.id}/reopen`)} className="mt-3">
                  <SubmitButton variant="secondary">Reopen roll</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          <Card title="Cut history">
            {sessions.length === 0 ? (
              <Empty>Not cut yet.</Empty>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {sessions.map((s) => (
                  <li key={s.id} className={`flex flex-wrap items-center gap-3 py-3 ${s.voidedAt ? "opacity-50" : ""}`}>
                    <div className="min-w-32 font-semibold">{formatDate(s.cutOn)}</div>
                    <div className="flex-1">
                      {s.lines.map((l) => `${l.qty} × ${l.label}`).join(", ")}
                      <div className="text-sm text-muted">
                        {s.createdBy}
                        {s.notes && ` · ${s.notes}`}
                        {s.voidedAt && ` · undone by ${s.voidedBy}`}
                      </div>
                    </div>
                    {can("undo") &&
                      !s.voidedAt &&
                      s.lines.every((l) => l.movedOn === 0) && (
                        <ActionForm
                          action={post(`/api/cuts/${s.id}/void`)}
                          confirm="Undo this cut? The pieces will be removed."
                        >
                          <SubmitButton variant="ghost">Undo</SubmitButton>
                        </ActionForm>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card title="What this roll became">
            <div className="mb-3 text-3xl font-semibold">{formatFeet(remainingFt)}</div>
            <div className="mb-4 text-muted">
              left of {formatFeet(roll.lengthFt)} ({formatFeet(usedFt)} cut)
            </div>
            {totals.length > 0 && (
              <Table>
                <tbody>
                  {totals.map((t) => (
                    <tr key={t.label}>
                      <td className="font-semibold">{t.label}</td>
                      <td className="text-right">{t.qty} pcs</td>
                      <td className="text-right text-muted">{formatFeet(t.feet)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {status !== "closed" && can("rolls:close") && (
            <Card title="Close out roll">
              <ActionForm
                action={post(`/api/rolls/${roll.id}/close`)}
                className="flex flex-col gap-3"
                confirm="Close out this roll?"
              >
                <Field label="Closed on">
                  <Input name="closedOn" type="date" defaultValue={today} required />
                </Field>
                <div>
                  <SubmitButton variant="secondary">Close out</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          )}
          {can("settings") && (
            <Card title="Price">
              {roll.cost == null ? (
                <p className="mb-3 text-danger">No price yet. Sales of pieces from this roll show fabric cost as missing.</p>
              ) : (
                <p className="mb-3">
                  {formatMoney(roll.cost)} for the roll · {formatMoney(roll.cost / roll.lengthFt)} per foot
                </p>
              )}
              <ActionForm action={patch(`/api/rolls/${roll.id}/cost`)} className="flex flex-wrap items-end gap-2">
                <Field label="Whole roll, with freight ($)">
                  <Input name="cost" type="number" step="0.01" min="0" inputMode="decimal" defaultValue={roll.cost ?? ""} className="w-36" />
                </Field>
                <SubmitButton variant="secondary">Save</SubmitButton>
              </ActionForm>
              <p className="mt-2 text-sm text-muted">
                A piece costs its cut length × the price per foot. Changing it re-costs sales from this roll.
              </p>
            </Card>
          )}
          {roll.notes && (
            <Card title="Notes">
              {roll.notes}
              {roll.sourceDocumentId && can("invoices:review") && (
                <button
                  type="button"
                  className="ml-2 text-brand underline"
                  onClick={async () => {
                    const tab = window.open("", "_blank");
                    const url = await documentFileUrl(roll.sourceDocumentId!).catch(() => null);
                    if (tab && url) tab.location.href = url;
                    else tab?.close();
                  }}
                >
                  View document
                </button>
              )}
              {roll.sourceDocumentId && <div className="mt-1 text-sm text-muted">Registered from a supplier email.</div>}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
