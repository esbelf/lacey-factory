import { formatFeet } from "@lacey-factory/shared/feet";
import { Link, useSearchParams } from "react-router";

import { useApi } from "../api";
import { Loading } from "../components/loading";
import { ButtonLink, Card, Empty, formatDate, PageHeader, StatusBadge, Table } from "../components/ui";
import { useTitle } from "../title";

export function RollsPage() {
  useTitle("Rolls");
  const [params] = useSearchParams();
  const show = params.get("show");
  const { data: all, error } = useApi("rolls");
  if (!all) return <Loading error={error} />;

  const open = all.filter((r) => r.status !== "closed");
  const rolls = show === "all" ? all : open;
  const closedCount = all.length - open.length;

  return (
    <>
      <PageHeader
        title="Rolls"
        subtitle="Uncut rolls first. Tap a roll to record a cut."
        action={<ButtonLink href="/rolls/new">+ Register roll</ButtonLink>}
      />
      <Card>
        {rolls.length === 0 ? (
          <Empty>No open rolls. Register one when it arrives.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Roll</th>
                <th>Material</th>
                <th>Received</th>
                <th>Size</th>
                <th className="text-right">Left</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rolls.map(({ roll, materialName, remainingFt, status }) => (
                <tr key={roll.id} className="hover:bg-canvas">
                  <td>
                    <Link to={`/rolls/${roll.id}`} className="font-semibold text-brand underline-offset-2 hover:underline">
                      {roll.appCode}
                    </Link>
                    {roll.supplierRollNo && <div className="text-sm text-muted">Supplier #{roll.supplierRollNo}</div>}
                  </td>
                  <td>{materialName}</td>
                  <td>{formatDate(roll.receivedOn)}</td>
                  <td className="whitespace-nowrap">
                    {formatFeet(roll.widthFt)} × {formatFeet(roll.lengthFt)}
                  </td>
                  <td className="text-right font-semibold">{formatFeet(remainingFt)}</td>
                  <td>
                    <StatusBadge status={status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {closedCount > 0 && (
          <p className="mt-3 text-sm">
            <Link className="text-brand underline" to={show === "all" ? "/rolls" : "/rolls?show=all"}>
              {show === "all" ? "Hide closed rolls" : `Show ${closedCount} closed roll${closedCount === 1 ? "" : "s"}`}
            </Link>
          </p>
        )}
      </Card>
    </>
  );
}
