import { formatFeet } from "@lacey-factory/shared/feet";
import type { ReactNode } from "react";

import { patch, post, type SteelData, type Supplier, useApi } from "../api";
import { ActionForm, SubmitButton } from "./action-form";
import { AddPanel, EditableRow, OffTag, SectionHeader, controlRow } from "./settings-ui";
import { Empty, Field, Input, Select } from "./ui";

type Material = {
  id: string;
  name: string;
  active: boolean;
  defaultWidthFt: number | null;
};

const KIND_LABEL = { rolls: "Rolls", steel: "Steel", boxes: "Boxes" } as const;

/** Settings → Suppliers: who sends us invoices, and how their products map to our rolls, steel poles or boxes. */
export function SuppliersCard({ materials, steelItems }: { materials: Material[]; steelItems: SteelData["items"] }) {
  const { data: suppliers } = useApi("suppliers");

  return (
    <>
      <SectionHeader title="Suppliers">
        Invoice emails to eric@lakemat.com from these senders are read automatically. Each product code turns an invoice
        line into rolls, steel poles or shipping boxes. Invoices with codes not listed here go to the Inbox for review.
      </SectionHeader>
      {!suppliers ? null : suppliers.length === 0 ? (
        <div className="p-6">
          <Empty>No suppliers yet. Load the LakeMat catalog or add one below.</Empty>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {suppliers.map((s) => (
            <EditableRow
              key={s.id}
              dim={!s.active}
              editLabel="Edit supplier"
              editor={(close) => (
                <ActionForm action={patch(`/api/suppliers/${s.id}`)} onSuccess={close} className={controlRow}>
                  <Field label="Supplier">
                    <Input name="name" defaultValue={s.name} className="w-60" required />
                  </Field>
                  <Field label="Sends from (emails or @domain)" hint="e.g. billing@hanesgeo.com, @hanesgeo.com">
                    <Input name="emailPatterns" defaultValue={s.emailPatterns.join(", ")} className="w-80" />
                  </Field>
                  <label className="flex h-11 items-center gap-2">
                    <input type="checkbox" name="active" defaultChecked={s.active} className="h-5 w-5" /> Active
                  </label>
                  <SubmitButton>Save</SubmitButton>
                </ActionForm>
              )}
              footer={
                s.kind === "rolls" ? (
                  <RollMappings supplier={s} materials={materials} />
                ) : (
                  <SteelMappings supplier={s} steelItems={steelItems} />
                )
              }
            >
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-lg font-semibold">{s.name}</span>
                <span className="rounded bg-brand/10 px-1.5 py-0.5 text-xs font-semibold text-brand">{KIND_LABEL[s.kind]}</span>
                {!s.active && <OffTag />}
              </div>
              <div className="mt-0.5 text-sm">
                {s.emailPatterns.length ? (
                  <span className="text-muted">From {s.emailPatterns.join(", ")}</span>
                ) : (
                  <span className="font-semibold text-danger">No sender set, so no emails will match</span>
                )}
              </div>
            </EditableRow>
          ))}
        </ul>
      )}

      <AddPanel label="Add supplier">
        {(close) => (
          <ActionForm action={post("/api/suppliers")} resetOnSuccess onSuccess={close} className={controlRow}>
            <Field label="Supplier">
              <Input name="name" placeholder="e.g. Hanes Geo Components" className="w-60" required />
            </Field>
            <Field label="Sends from">
              <Input name="emailPatterns" placeholder="billing@supplier.com, @supplier.com" className="w-80" required />
            </Field>
            <Field label="Supplies">
              <Select name="kind" defaultValue="rolls" className="w-32">
                <option value="rolls">Rolls</option>
                <option value="steel">Steel</option>
                <option value="boxes">Boxes</option>
              </Select>
            </Field>
            <SubmitButton>Add supplier</SubmitButton>
          </ActionForm>
        )}
      </AddPanel>
    </>
  );
}

/** Product code → what it becomes, as a small table under the supplier. */
function MappingTable({ heading, children, empty }: { heading: string; children: ReactNode[]; empty: boolean }) {
  return (
    <div className="mt-3 rounded-lg border border-line">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th className="w-32 px-3 py-2 font-medium">Product code</th>
            <th className="px-3 py-2 font-medium">{heading}</th>
            <th className="w-24 px-3 py-2">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody className="[&_td]:border-t [&_td]:border-line">
          {empty ? (
            <tr>
              <td colSpan={3} className="px-3 py-3 text-muted">
                No product codes yet. Every invoice from this supplier will go to the Inbox.
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}

function MappingRow({ code, children, remove }: { code: string | null; children: ReactNode; remove: string }) {
  return (
    <tr>
      <td className="px-3 py-1.5 font-semibold tabular-nums">{code ?? "—"}</td>
      <td className="px-3 py-1.5">{children}</td>
      <td className="px-3 py-1 text-right">
        <ActionForm action={post(remove)} confirm="Remove this product code?">
          <SubmitButton variant="ghost">Remove</SubmitButton>
        </ActionForm>
      </td>
    </tr>
  );
}

function Matches({ text }: { text: string | null }) {
  return text ? <span className="text-muted"> (or description contains “{text}”)</span> : null;
}

function RollMappings({ supplier, materials }: { supplier: Supplier; materials: Material[] }) {
  const active = materials.filter((m) => m.active);
  return (
    <>
      <MappingTable heading="Becomes a roll of" empty={supplier.products.length === 0}>
        {supplier.products.map(({ product, materialName }) => (
          <MappingRow key={product.id} code={product.productCode} remove={`/api/supplier-products/${product.id}/delete`}>
            {materialName}{" "}
            <span className="tabular-nums">
              {formatFeet(product.widthFt)} × {formatFeet(product.lengthFt)}
            </span>
            <Matches text={product.descriptionMatch} />
          </MappingRow>
        ))}
      </MappingTable>
      <AddPanel label="Add product code" inline>
        {(close) => (
          <ActionForm action={post(`/api/suppliers/${supplier.id}/products`)} resetOnSuccess onSuccess={close} className={controlRow}>
            <Field label="Product code">
              <Input name="productCode" placeholder="38151" className="w-28" />
            </Field>
            <Field label="Or description contains">
              <Input name="descriptionMatch" placeholder="TERRATEX N06" className="w-44" />
            </Field>
            <Field label="Material">
              <Select name="materialId" required defaultValue="" className="w-52">
                <option value="" disabled>
                  Pick a material…
                </option>
                {active.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Width (ft)">
              <Input name="widthFt" type="number" step="0.01" min="0" inputMode="decimal" className="w-24" required />
            </Field>
            <Field label="Length (ft)">
              <Input name="lengthFt" type="number" step="0.01" min="0" inputMode="decimal" className="w-24" required />
            </Field>
            <SubmitButton>Add product code</SubmitButton>
          </ActionForm>
        )}
      </AddPanel>
    </>
  );
}

/** Steel and box suppliers: product code → pole or box (only the kind this supplier sends). */
function SteelMappings({ supplier, steelItems }: { supplier: Supplier; steelItems: SteelData["items"] }) {
  const boxes = supplier.kind === "boxes";
  const active = steelItems.filter((i) => i.active && i.kind === (boxes ? "box" : "steel"));
  return (
    <>
      <MappingTable heading="Becomes" empty={supplier.steelProducts.length === 0}>
        {supplier.steelProducts.map(({ product, steelItemName }) => (
          <MappingRow key={product.id} code={product.productCode} remove={`/api/supplier-steel-products/${product.id}/delete`}>
            {steelItemName}
            <Matches text={product.descriptionMatch} />
          </MappingRow>
        ))}
      </MappingTable>
      {active.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{boxes ? "Add box sizes under Boxes first." : "Add pole types under Steel poles first."}</p>
      ) : (
        <AddPanel label="Add product code" inline>
          {(close) => (
            <ActionForm action={post(`/api/suppliers/${supplier.id}/steel-products`)} resetOnSuccess onSuccess={close} className={controlRow}>
              <Field label="Product code">
                <Input name="productCode" placeholder={boxes ? "RSC-581408" : "SP-114-10"} className="w-32" />
              </Field>
              <Field label="Or description contains">
                <Input name="descriptionMatch" placeholder={boxes ? "58 X 14 X 8" : `1-1/4" GALV`} className="w-44" />
              </Field>
              <Field label={boxes ? "Box" : "Pole"}>
                <Select name="steelItemId" required defaultValue="" className="w-60">
                  <option value="" disabled>
                    Pick one…
                  </option>
                  {active.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton>Add product code</SubmitButton>
            </ActionForm>
          )}
        </AddPanel>
      )}
    </>
  );
}
