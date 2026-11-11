import { formatMoney } from "@lacey-factory/shared/money";
import { useSearchParams } from "react-router";

import { patch, post, type Product, type SteelData } from "../api";
import { ActionForm, SubmitButton } from "./action-form";
import { Card, Empty, Field, Input, Select } from "./ui";

type StockItem = SteelData["items"][number];
type Kind = StockItem["kind"];

/** "58 × 14 × 8 in" for a box with a size. */
export function boxSize(i: Pick<StockItem, "lengthIn" | "widthIn" | "heightIn">) {
  return i.lengthIn && i.widthIn && i.heightIn ? `${i.lengthIn} × ${i.widthIn} × ${i.heightIn} in` : "—";
}

const COPY: Record<Kind, { title: string; intro: string; empty: string; add: string; placeholder: string }> = {
  steel: {
    title: "Steel poles",
    intro: "Pole types we stock, counted by the piece. Map a steel supplier's product codes to these under Suppliers.",
    empty: "No steel items yet.",
    add: "pole type",
    placeholder: `e.g. 1-1/4" × 10' galvanized`,
  },
  box: {
    title: "Boxes",
    intro: "Shipping boxes we stock. Each product ships in one box (set under Products), taken out when it sells.",
    empty: "No boxes yet. Load the LakeMat catalog to add the standard boxes.",
    add: "box",
    placeholder: "e.g. LAKEMAT BOX",
  },
};

function SizeFields({ item }: { item?: StockItem }) {
  return (
    <>
      {(["lengthIn", "widthIn", "heightIn"] as const).map((f, n) => (
        <Field key={f} label={["L (in)", "W (in)", "H (in)"][n]}>
          <Input name={f} type="number" step="0.01" min="0" inputMode="decimal" defaultValue={item?.[f] ?? ""} className="w-20" />
        </Field>
      ))}
    </>
  );
}

/** Settings → Steel poles / Boxes: the parts we stock by the piece. */
export function SteelItemsCard({ items, kind = "steel" }: { items: StockItem[]; kind?: Kind }) {
  const c = COPY[kind];
  const shown = items.filter((i) => i.kind === kind);
  return (
    <Card title={c.title}>
      <p className="mb-3 text-sm text-muted">{c.intro}</p>
      {shown.length === 0 ? (
        <Empty>{c.empty}</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((i) => (
            <li key={i.id} className={`rounded-lg border border-line p-3 ${i.active ? "" : "opacity-60"}`}>
              <ActionForm action={patch(`/api/steel-items/${i.id}`)} className="flex flex-wrap items-end gap-3">
                <Field label="Name">
                  <Input name="name" defaultValue={i.name} className="w-56" required />
                </Field>
                {kind === "box" && <SizeFields item={i} />}
                <Field label="Order">
                  <Input name="sortOrder" type="number" step="1" defaultValue={i.sortOrder} className="w-20" />
                </Field>
                <label className="flex h-11 items-center gap-2">
                  <input type="checkbox" name="active" defaultChecked={i.active} className="h-5 w-5" /> Active
                </label>
                <SubmitButton variant="secondary">Save</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={post("/api/steel-items")} resetOnSuccess className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <input type="hidden" name="kind" value={kind} />
        <Field label={`New ${c.add}`}>
          <Input name="name" placeholder={c.placeholder} className="w-56" required />
        </Field>
        {kind === "box" && <SizeFields />}
        <Field label="Order">
          <Input name="sortOrder" type="number" step="1" defaultValue={0} className="w-20" />
        </Field>
        <SubmitButton>Add {c.add}</SubmitButton>
      </ActionForm>
    </Card>
  );
}

/** Settings → Products: what each product uses and ships in, editable here. */
/** Settings → Products tabs, each covering one or more product lines. */
const PRODUCT_GROUPS: { id: string; label: string; lines: string[] }[] = [
  { id: "lakemat", label: "LakeMat", lines: ["LakeMat"] },
  { id: "muckmat", label: "MuckMat", lines: ["MuckMat"] },
  { id: "boatlift", label: "Boatlift", lines: ["Boatlift Mat", "Boatlift Slip"] },
  { id: "kayak", label: "Kayak Mat", lines: ["Kayak Mat"] },
  { id: "sandmat", label: "SandMat", lines: ["SandMat"] },
  { id: "hydrilla", label: "Hydrilla & Lily Hammer", lines: ["Hydrilla", "Lily Hammer"] },
  { id: "lake-buddy", label: "Lake Buddy", lines: ["Lake Buddy"] },
  { id: "sandmat-max", label: "SandMat Max", lines: ["SandMat MAX"] },
  { id: "dockmat", label: "DockMat", lines: ["DockMat"] },
];

function productGroup(productLine: string) {
  const line = productLine.toLowerCase();
  return PRODUCT_GROUPS.find((g) => g.lines.some((l) => l.toLowerCase() === line))?.id ?? "other";
}

export function ProductsCard({ products, steelItems, canEdit }: { products: Product[]; steelItems: StockItem[]; canEdit: boolean }) {
  const steel = steelItems.filter((i) => i.active && i.kind === "steel");
  const boxes = steelItems.filter((i) => i.kind === "box" && i.active);
  const [params, setParams] = useSearchParams();
  const hasOther = products.some((p) => productGroup(p.product.productLine) === "other");
  const groups = hasOther ? [...PRODUCT_GROUPS, { id: "other", label: "Other", lines: [] }] : PRODUCT_GROUPS;
  const group = groups.find((g) => g.id === params.get("group")) ?? groups[0];
  const shown = products.filter((p) => productGroup(p.product.productLine) === group.id);
  return (
    <Card title="Products">
      {products.length === 0 ? (
        <Empty>No products yet. Load the LakeMat catalog to add them.</Empty>
      ) : (
        <>
          <div role="tablist" aria-label="Product groups" className="mb-3 flex flex-wrap gap-2">
            {groups.map((g) => {
              const selected = g.id === group.id;
              const count = products.filter((p) => productGroup(p.product.productLine) === g.id).length;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setParams({ tab: "products", group: g.id }, { replace: true })}
                  className={`rounded-full border px-4 py-1.5 font-semibold ${
                    selected ? "border-brand bg-brand text-white" : "border-line text-muted hover:text-ink"
                  }`}
                >
                  {g.label} <span className={selected ? "opacity-80" : "text-muted"}>({count})</span>
                </button>
              );
            })}
          </div>
          {shown.length === 0 ? (
            <Empty>No {group.label} products yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {shown.map(({ product, uses, steel: parts, box }) => (
                <li key={product.id} className="py-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-semibold">
                      {product.name}
                      {product.sku && <span className="ml-2 text-sm font-normal text-muted">{product.sku}</span>}
                    </span>
                    <span className="text-sm text-muted">
                      {uses.map((u) => `${u.qty > 1 ? `${u.qty} × ` : ""}${u.material} ${u.label}`).join(" + ") || "No fabric"}
                    </span>
                  </div>
                  <div className="mt-1 text-sm">
                    Steel: {parts.length ? parts.map((s) => `${s.qty} × ${s.name}`).join(" + ") : <span className="text-muted">none</span>}
                    {" · "}Box: {box ? box.name : <span className="text-danger">none</span>}
                    {product.shipWeightLb != null && ` · ${product.shipWeightLb} lb packed`}
                    {(product.sewCostInHouse != null || product.sewCostSummit != null) &&
                      ` · Sewing: in-house ${formatMoney(product.sewCostInHouse)}, Summit ${formatMoney(product.sewCostSummit)}`}
                  </div>
                  {canEdit && (
                    <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2">
                      {steel.length > 0 && (
                        <ActionForm action={post(`/api/products/${product.id}/steel`)} resetOnSuccess className="flex flex-wrap items-end gap-2">
                          <Field label="Pole">
                            <Select name="steelItemId" required defaultValue="" className="w-48">
                              <option value="" disabled>
                                Pick…
                              </option>
                              {steel.map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Per product" hint="0 removes it">
                            <Input name="qty" type="number" step="1" min="0" inputMode="numeric" className="w-20" required />
                          </Field>
                          <SubmitButton variant="secondary">Set</SubmitButton>
                        </ActionForm>
                      )}
                      {boxes.length > 0 && (
                        <ActionForm action={post(`/api/products/${product.id}/box`)} className="flex flex-wrap items-end gap-2">
                          <Field label="Ships in">
                            <Select name="boxId" defaultValue={box?.steelItemId ?? ""} className="w-48">
                              <option value="">No box</option>
                              {boxes.map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <SubmitButton variant="secondary">Save</SubmitButton>
                        </ActionForm>
                      )}
                      <ActionForm action={patch(`/api/products/${product.id}`)} className="flex flex-wrap items-end gap-2">
                        <Field label="Our SKU">
                          <Input name="sku" defaultValue={product.sku ?? ""} className="w-32" />
                        </Field>
                        <Field label="Packed lb">
                          <Input name="shipWeightLb" type="number" step="0.01" min="0" inputMode="decimal" defaultValue={product.shipWeightLb ?? ""} className="w-24" />
                        </Field>
                        <Field label="Sewing in-house $" hint="Per product">
                          <Input name="sewCostInHouse" type="number" step="0.01" min="0" inputMode="decimal" defaultValue={product.sewCostInHouse ?? ""} className="w-28" />
                        </Field>
                        <Field label="Sewing at Summit $" hint="Per product">
                          <Input name="sewCostSummit" type="number" step="0.01" min="0" inputMode="decimal" defaultValue={product.sewCostSummit ?? ""} className="w-28" />
                        </Field>
                        <SubmitButton variant="secondary">Save</SubmitButton>
                      </ActionForm>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="mt-3 text-sm text-muted">
        Nothing is set aside for a product until it sells. A sale takes out the steel, fabric and box listed here. A
        product needs fabric or steel before it can be sold. LakeMat and MuckMat draw from the same sewn N06 pieces.
        Sewing cost is charged per product sold, by who sewed its pieces, at the rates set when it sells.
      </p>
    </Card>
  );
}
