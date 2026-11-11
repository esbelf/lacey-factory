import { todayInMichigan } from "@lacey-factory/shared/feet";
import { formatMoney, mulMoney, sumMoney } from "@lacey-factory/shared/money";
import clsx from "clsx";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { documentFileUrl, post, type SteelData, type SupplierDocument, useApi } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import { buttonClass, Card, Empty, Field, formatDate, Input, PageHeader, Select } from "../components/ui";
import { useCan } from "../me";
import { useTitle } from "../title";

const STATUS: Record<SupplierDocument["status"], { label: string; className: string }> = {
  processing: { label: "Reading…", className: "bg-line text-muted" },
  registered: { label: "Registered", className: "bg-success/15 text-success" },
  needs_review: { label: "Needs review", className: "bg-warn/25 text-ink" },
  not_invoice: { label: "Not an invoice", className: "bg-line text-muted" },
  duplicate: { label: "Duplicate", className: "bg-line text-muted" },
  failed: { label: "Failed", className: "bg-danger/15 text-danger" },
};

type Extraction = {
  document_type?: string;
  invoice_total?: number | null;
  lines?: {
    line_kind?: "product" | "freight" | "tax" | "other";
    unit_price?: number | null;
    amount?: number | null;
    product_code: string | null;
    description: string;
    quantity: number | null;
    uom: string | null;
    width_ft: number | null;
    length_ft: number | null;
    roll_numbers: string[];
  }[];
};

export function InboxPage() {
  useTitle("Inbox");
  const can = useCan();
  const [params] = useSearchParams();
  const docs = useApi("documents", { refetchInterval: 15_000 });
  const email = useApi("emailStatus", { enabled: can("email:connect") });
  const materials = useApi("materials");
  const steel = useApi("steel");
  if (!docs.data || !materials.data || !steel.data) return <Loading error={docs.error ?? materials.error ?? steel.error} />;
  const steelItems = steel.data.items.filter((i) => i.active);
  const activeMaterials = materials.data.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name }));

  const review = docs.data.filter((d) => d.status === "needs_review");
  const rest = docs.data.filter((d) => d.status !== "needs_review");

  return (
    <>
      <PageHeader
        title="Supplier inbox"
        subtitle="Invoices and packing lists emailed by suppliers. Rolls, steel and boxes are registered automatically when every line matches a known product and adds up; anything else waits here for review."
      />

      {params.get("email") === "connected" && (
        <p role="status" className="mb-4 rounded-lg bg-success/15 p-3 font-medium text-success">
          Email connected. New supplier emails are picked up within seconds.
        </p>
      )}
      {params.get("email") === "error" && (
        <p role="alert" className="mb-4 rounded-lg bg-danger/10 p-3 font-medium text-danger">
          Couldn&apos;t connect email: {params.get("message")}
        </p>
      )}
      {email.data && email.data.status !== "connected" && (
        <p className="mb-4 rounded-lg bg-warn/20 p-3">
          {email.data.email} isn&apos;t connected, so new supplier emails aren&apos;t being read. Use{" "}
          <strong>{email.data.status === "needs_reauth" ? "Reconnect email" : "Connect Email"}</strong> at the top.
        </p>
      )}
      {email.data?.status === "connected" && can("email:connect") && (
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted">
          Reading {email.data.email}
          {email.data.connectedAt && <> · connected {formatDate(email.data.connectedAt.slice(0, 10))}</>}
          {email.data.mode === "fake" && <> · local test mode (npm run simulate)</>}
          <ActionForm action={post("/api/email/disconnect")} confirm="Stop reading supplier emails?">
            <SubmitButton variant="ghost">Disconnect</SubmitButton>
          </ActionForm>
        </div>
      )}

      {review.length > 0 && (
        <div className="mb-6 flex flex-col gap-4">
          {review.map((d) =>
            d.supplierKind === "steel" || d.supplierKind === "boxes" ? (
              <SteelReviewCard
                key={d.id}
                doc={d}
                boxes={d.supplierKind === "boxes"}
                steelItems={steelItems.filter((i) => i.kind === (d.supplierKind === "boxes" ? "box" : "steel"))}
              />
            ) : (
              <ReviewCard key={d.id} doc={d} materials={activeMaterials} />
            ),
          )}
        </div>
      )}

      <Card title="Recent documents">
        {rest.length === 0 ? (
          <Empty>Nothing yet. Supplier invoices show up here when they arrive by email.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {rest.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {d.supplierName} {d.invoiceNumber && <>· #{d.invoiceNumber}</>}
                  </div>
                  <div className="text-sm text-muted">
                    {d.emailSubject} · {formatDate(d.emailReceivedAt.slice(0, 10))}
                    {d.reviewReason && <> · {d.reviewReason}</>}
                  </div>
                  {d.steel.length > 0 && (
                    <div className="mt-1 text-sm">
                      {d.steel.map((l) => `${l.qty} × ${l.name} @ ${formatMoney(l.unitCost)}`).join(" · ")}
                      {d.shippingCost != null && <> · freight {formatMoney(d.shippingCost)}</>}
                      {d.invoiceTotal != null && <> · total {formatMoney(d.invoiceTotal)}</>}
                    </div>
                  )}
                  {d.rolls.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-2 text-sm">
                      {d.rolls.map((r) => (
                        <Link key={r.id} to={`/rolls/${r.id}`} className="font-semibold text-brand underline">
                          {r.appCode}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
                <StatusPill status={d.status} />
                <ViewButton id={d.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function StatusPill({ status }: { status: SupplierDocument["status"] }) {
  const s = STATUS[status];
  return <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", s.className)}>{s.label}</span>;
}

function ViewButton({ id }: { id: string }) {
  const [error, setError] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass("ghost")}
      onClick={async () => {
        // Open the tab first so popup blockers allow it, then point it at the signed link.
        const tab = window.open("", "_blank");
        try {
          const url = await documentFileUrl(id);
          if (tab) tab.location.href = url;
          else window.location.assign(url);
        } catch {
          tab?.close();
          setError(true);
        }
      }}
    >
      {error ? "Couldn't open" : "View"}
    </button>
  );
}

type Line = { materialId: string; widthFt: string; lengthFt: string; count: string; rollNumbers: string; rollCost: string };

/** Price of one roll from the invoice line: its rate when priced per roll, else amount ÷ rolls. */
function rollPriceGuess(l: NonNullable<Extraction["lines"]>[number], count: number): string {
  if (l.unit_price != null && /^(roll|rolls|rl|rls)$/i.test(l.uom ?? "")) return String(l.unit_price);
  if (l.amount != null && count > 0) return String(Math.round((l.amount / count) * 100) / 100);
  return "";
}

/** Pre-filled from Claude's reading; a person fixes it and registers the rolls. */
function ReviewCard({ doc, materials: active }: { doc: SupplierDocument; materials: { id: string; name: string }[] }) {
  const extracted = (doc.extracted ?? {}) as Extraction;
  const guess = (description: string) =>
    active.find((m) => description.toLowerCase().includes(m.name.toLowerCase()))?.id ?? "";

  const [lines, setLines] = useState<Line[]>(() =>
    (extracted.lines ?? [])
      .filter((l) => l.product_code || l.width_ft != null || l.roll_numbers.length)
      .map((l) => {
        const count = String(l.roll_numbers.length || (l.uom && /^(roll|rl)s?$/i.test(l.uom) ? l.quantity : "") || "");
        return {
          materialId: guess(l.description),
          widthFt: l.width_ft?.toString() ?? "",
          lengthFt: l.length_ft?.toString() ?? "",
          count,
          rollNumbers: l.roll_numbers.join(", "),
          rollCost: rollPriceGuess(l, Number(count)),
        };
      }),
  );
  const freightAmounts = (extracted.lines ?? []).filter((l) => l.line_kind === "freight" && l.amount != null).map((l) => l.amount!);
  const freightGuess = freightAmounts.length ? String(sumMoney(freightAmounts)) : "";
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const receivedOn = doc.shipDate ?? doc.invoiceDate ?? todayInMichigan();

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-3">
          {doc.supplierName} {doc.invoiceNumber && <>· #{doc.invoiceNumber}</>}
          <StatusPill status={doc.status} />
          <ViewButton id={doc.id} />
        </span>
      }
    >
      <p className="mb-3 text-sm text-muted">
        {doc.emailSubject} · {doc.filename} · {formatDate(doc.emailReceivedAt.slice(0, 10))}
      </p>
      {doc.reviewReason && <p className="mb-3 rounded-lg bg-warn/20 p-3">{doc.reviewReason}</p>}

      <DocumentLines extracted={extracted} />

      <ActionForm action={post(`/api/documents/${doc.id}/register`)} className="flex flex-col gap-3">
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-3">
            <Field label="Material">
              <Select value={l.materialId} onChange={(e) => set(i, { materialId: e.target.value })} required className="w-52">
                <option value="" disabled>
                  Pick…
                </option>
                {active.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Width (ft)">
              <Input value={l.widthFt} onChange={(e) => set(i, { widthFt: e.target.value })} inputMode="decimal" className="w-24" required />
            </Field>
            <Field label="Length (ft)">
              <Input value={l.lengthFt} onChange={(e) => set(i, { lengthFt: e.target.value })} inputMode="decimal" className="w-24" required />
            </Field>
            <Field label="Rolls">
              <Input value={l.count} onChange={(e) => set(i, { count: e.target.value })} inputMode="numeric" className="w-20" required />
            </Field>
            <Field label="Roll numbers (optional)">
              <Input value={l.rollNumbers} onChange={(e) => set(i, { rollNumbers: e.target.value })} className="w-72" />
            </Field>
            <Field label="Price per roll ($)" hint="Before freight">
              <Input value={l.rollCost} onChange={(e) => set(i, { rollCost: e.target.value })} inputMode="decimal" className="w-28" />
            </Field>
            <button type="button" className={buttonClass("ghost")} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className={buttonClass("secondary")}
            onClick={() => setLines((ls) => [...ls, { materialId: "", widthFt: "", lengthFt: "", count: "1", rollNumbers: "", rollCost: "" }])}
          >
            + Add line
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Received on">
            <Input type="date" name="receivedOn" defaultValue={receivedOn} required />
          </Field>
          <Field label="Freight ($)" hint="Split over the rolls by price">
            <Input name="freight" defaultValue={freightGuess} inputMode="decimal" className="w-28" />
          </Field>
          <SubmitButton>Register rolls</SubmitButton>
        </div>
      </ActionForm>
      <DismissButton id={doc.id} />
    </Card>
  );
}

function DismissButton({ id }: { id: string }) {
  return (
    <ActionForm action={post(`/api/documents/${id}/dismiss`)} confirm="Mark this as not an invoice we track?" className="mt-2">
      <SubmitButton variant="ghost">Not an invoice we track</SubmitButton>
    </ActionForm>
  );
}

function DocumentLines({ extracted }: { extracted: Extraction }) {
  if (!extracted.lines?.length) return null;
  return (
    <details className="mb-4 text-sm">
      <summary className="cursor-pointer text-muted">What the document says ({extracted.lines.length} lines)</summary>
      <ul className="mt-2 list-disc pl-5">
        {extracted.lines.map((l, i) => (
          <li key={i}>
            {l.product_code && <strong>{l.product_code} </strong>}
            {l.description} — {l.quantity ?? "?"} {l.uom ?? ""}
            {l.unit_price != null && <> @ {formatMoney(l.unit_price)}</>}
            {l.amount != null && <> = {formatMoney(l.amount)}</>}
            {l.line_kind && l.line_kind !== "product" && <span className="text-muted"> ({l.line_kind})</span>}
            {l.roll_numbers.length > 0 && <> · {l.roll_numbers.join(", ")}</>}
          </li>
        ))}
      </ul>
      {extracted.invoice_total != null && <p className="mt-1">Invoice total {formatMoney(extracted.invoice_total)}</p>}
    </details>
  );
}

type SteelLine = { steelItemId: string; qty: string; unitCost: string };

/** Steel or box invoice that needs a person: pick the pole or box for each line, check qty, rate and freight. */
function SteelReviewCard({ doc, steelItems, boxes }: { doc: SupplierDocument; steelItems: SteelData["items"]; boxes: boolean }) {
  const w = boxes ? { one: "Box", many: "Boxes", per: "box", stock: "box" } : { one: "Pole", many: "Poles", per: "pole", stock: "steel" };
  const extracted = (doc.extracted ?? {}) as Extraction;
  const all = extracted.lines ?? [];
  const isFreight = (l: (typeof all)[number]) => l.line_kind === "freight" || (!l.line_kind && /freight|shipping/i.test(l.description));
  const products = all.filter((l) => !isFreight(l) && (!l.line_kind || l.line_kind === "product"));

  const [lines, setLines] = useState<SteelLine[]>(() =>
    products.map((l) => ({
      steelItemId: "",
      qty: l.quantity?.toString() ?? "",
      unitCost: (l.unit_price ?? (l.amount != null && l.quantity ? l.amount / l.quantity : null))?.toString() ?? "",
    })),
  );
  const [freight, setFreight] = useState(
    () => (doc.shippingCost ?? sumMoney(all.filter(isFreight).map((l) => l.amount ?? 0))).toString(),
  );
  const set = (i: number, patch: Partial<SteelLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const goods = sumMoney(lines.map((l) => mulMoney(Number(l.qty) || 0, Number(l.unitCost) || 0)));

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-3">
          {doc.supplierName} {doc.invoiceNumber && <>· #{doc.invoiceNumber}</>}
          <StatusPill status={doc.status} />
          <ViewButton id={doc.id} />
        </span>
      }
    >
      <p className="mb-3 text-sm text-muted">
        {doc.emailSubject} · {doc.filename} · {formatDate(doc.emailReceivedAt.slice(0, 10))}
      </p>
      {doc.reviewReason && <p className="mb-3 rounded-lg bg-warn/20 p-3">{doc.reviewReason}</p>}
      <DocumentLines extracted={extracted} />

      <ActionForm action={post(`/api/documents/${doc.id}/receive-steel`)} className="flex flex-col gap-3">
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-3">
            {products[i] && <div className="w-full text-sm text-muted">{products[i].description}</div>}
            <Field label={w.one}>
              <Select value={l.steelItemId} onChange={(e) => set(i, { steelItemId: e.target.value })} required className="w-56">
                <option value="" disabled>
                  Pick…
                </option>
                {steelItems.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={w.many}>
              <Input value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} inputMode="numeric" className="w-24" required />
            </Field>
            <Field label={`Rate per ${w.per} ($)`}>
              <Input value={l.unitCost} onChange={(e) => set(i, { unitCost: e.target.value })} inputMode="decimal" className="w-32" required />
            </Field>
            <button type="button" className={buttonClass("ghost")} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className={buttonClass("secondary")}
            onClick={() => setLines((ls) => [...ls, { steelItemId: "", qty: "", unitCost: "" }])}
          >
            + Add line
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Freight ($)" hint="Spread over the lines by value">
            <Input name="freight" value={freight} onChange={(e) => setFreight(e.target.value)} inputMode="decimal" className="w-32" required />
          </Field>
          <Field label="Received on">
            <Input type="date" name="receivedOn" defaultValue={doc.shipDate ?? doc.invoiceDate ?? todayInMichigan()} required />
          </Field>
          <SubmitButton>Add to {w.stock} inventory</SubmitButton>
        </div>
        <p className="text-sm text-muted">
          {w.many} {formatMoney(goods)} + freight {formatMoney(Number(freight) || 0)} ={" "}
          <strong>{formatMoney(sumMoney([goods, Number(freight) || 0]))}</strong>
          {doc.invoiceTotal != null && <> · invoice total {formatMoney(doc.invoiceTotal)}</>}
        </p>
      </ActionForm>
      <DismissButton id={doc.id} />
    </Card>
  );
}
