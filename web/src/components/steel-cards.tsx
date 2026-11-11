import { formatMoney } from "@lacey-factory/shared/money";
import { useSearchParams } from "react-router";

import { patch, post, type Product, type SteelData } from "../api";
import { boxSize } from "../box-size";
import { ActionForm, SubmitButton } from "./action-form";
import { AddPanel, ChipTabs, EditableRow, Fact, OffTag, SectionHeader, controlRow } from "./settings-ui";
import { Empty, Field, Input, Select } from "./ui";

type StockItem = SteelData["items"][number];
type Kind = StockItem["kind"];

const COPY: Record<Kind, { title: string; intro: string; empty: string; add: string; placeholder: string }> = {
  steel: {
    title: "Steel poles",
    intro: "Pole types we stock, counted by the piece. Map a steel supplier's product codes to these under Suppliers.",
    empty: "No pole types yet. Add the first one below.",
    add: "pole type",
    placeholder: `e.g. 1-1/4" × 10' galvanized`,
  },
  box: {
    title: "Boxes",
    intro: "Shipping boxes we stock. Each product ships in one box, set under Products, and it's taken out when the product sells.",
    empty: "No boxes yet. Load the LakeMat catalog to add the standard boxes.",
    add: "box",
    placeholder: "e.g. LAKEMAT BOX",
  },
};

function SizeFields({ item }: { item?: StockItem }) {
  return (
    <>
      {(["lengthIn", "widthIn", "heightIn"] as const).map((f, n) => (
        <Field key={f} label={["Length (in)", "Width (in)", "Height (in)"][n]}>
          <Input name={f} type="number" step="0.01" min="0" inputMode="decimal" defaultValue={item?.[f] ?? ""} className="w-24" />
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
    <>
      <SectionHeader title={c.title}>{c.intro}</SectionHeader>
      {shown.length === 0 ? (
        <div className="p-6">
          <Empty>{c.empty}</Empty>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((i) => (
            <EditableRow
              key={i.id}
              dim={!i.active}
              editor={(close) => (
                <ActionForm action={patch(`/api/steel-items/${i.id}`)} onSuccess={close} className={controlRow}>
                  <Field label="Name">
                    <Input name="name" defaultValue={i.name} className="w-64" required />
                  </Field>
                  {kind === "box" && <SizeFields item={i} />}
                  <Field label="Order">
                    <Input name="sortOrder" type="number" step="1" defaultValue={i.sortOrder} className="w-20" />
                  </Field>
                  <label className="flex h-11 items-center gap-2">
                    <input type="checkbox" name="active" defaultChecked={i.active} className="h-5 w-5" /> Active
                  </label>
                  <SubmitButton>Save</SubmitButton>
                </ActionForm>
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className="min-w-48 flex-1 font-semibold">
                  {i.name}
                  {!i.active && <OffTag />}
                </span>
                {kind === "box" && <span className="text-sm text-muted tabular-nums">{boxSize(i)}</span>}
              </div>
            </EditableRow>
          ))}
        </ul>
      )}
      <AddPanel label={`Add ${c.add}`}>
        {(close) => (
          <ActionForm action={post("/api/steel-items")} resetOnSuccess onSuccess={close} className={controlRow}>
            <input type="hidden" name="kind" value={kind} />
            <Field label="Name">
              <Input name="name" placeholder={c.placeholder} className="w-64" required />
            </Field>
            {kind === "box" && <SizeFields />}
            <Field label="Order">
              <Input name="sortOrder" type="number" step="1" defaultValue={0} className="w-20" />
            </Field>
            <SubmitButton>Add {c.add}</SubmitButton>
          </ActionForm>
        )}
      </AddPanel>
    </>
  );
}

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

/** Settings → Products: what each product uses and ships in, editable here. */
export function ProductsCard({ products, steelItems, canEdit }: { products: Product[]; steelItems: StockItem[]; canEdit: boolean }) {
  const steel = steelItems.filter((i) => i.active && i.kind === "steel");
  const boxes = steelItems.filter((i) => i.kind === "box" && i.active);
  const [params, setParams] = useSearchParams();
  const hasOther = products.some((p) => productGroup(p.product.productLine) === "other");
  const groups = hasOther ? [...PRODUCT_GROUPS, { id: "other", label: "Other", lines: [] }] : PRODUCT_GROUPS;
  const group = groups.find((g) => g.id === params.get("group")) ?? groups[0];
  const shown = products.filter((p) => productGroup(p.product.productLine) === group.id);
  return (
    <>
      <SectionHeader title="Products">
        What a sale takes out of stock. Nothing is set aside until it sells, and a product needs fabric or steel before it
        can be sold. LakeMat and MuckMat draw from the same sewn N06 pieces.
      </SectionHeader>
      {products.length === 0 ? (
        <div className="p-6">
          <Empty>No products yet. Load the LakeMat catalog to add them.</Empty>
        </div>
      ) : (
        <>
          <ChipTabs
            label="Product groups"
            value={group.id}
            onChange={(id) => setParams({ tab: "products", group: id }, { replace: true })}
            items={groups.map((g) => ({
              id: g.id,
              label: g.label,
              count: products.filter((p) => productGroup(p.product.productLine) === g.id).length,
            }))}
          />
          {shown.length === 0 ? (
            <div className="p-6">
              <Empty>No {group.label} products yet.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {shown.map(({ product, uses, steel: parts, box }) => (
                <EditableRow
                  key={product.id}
                  canEdit={canEdit}
                  editor={() => (
                    <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
                      <ActionForm action={patch(`/api/products/${product.id}`)} className={controlRow}>
                        <Field label="Our SKU">
                          <Input name="sku" defaultValue={product.sku ?? ""} className="w-32" />
                        </Field>
                        <Field label="Packed weight (lb)">
                          <Input name="shipWeightLb" type="number" step="0.01" min="0" inputMode="decimal" defaultValue={product.shipWeightLb ?? ""} className="w-32" />
                        </Field>
                        <Field label="Sewing in-house ($)">
                          <Input name="sewCostInHouse" type="number" step="0.01" min="0" inputMode="decimal" defaultValue={product.sewCostInHouse ?? ""} className="w-32" />
                        </Field>
                        <Field label="Sewing at Summit ($)">
                          <Input name="sewCostSummit" type="number" step="0.01" min="0" inputMode="decimal" defaultValue={product.sewCostSummit ?? ""} className="w-32" />
                        </Field>
                        <SubmitButton variant="secondary">Save details</SubmitButton>
                        <p className="basis-full text-xs text-muted">
                          Sewing is charged per product sold, by who sewed its pieces, at the rate in place when it sells.
                        </p>
                      </ActionForm>
                      <div className="flex flex-wrap gap-x-10 gap-y-4 border-t border-line pt-4">
                        {boxes.length > 0 && (
                          <ActionForm action={post(`/api/products/${product.id}/box`)} className={controlRow}>
                            <Field label="Ships in">
                              <Select name="boxId" defaultValue={box?.steelItemId ?? ""} className="w-56">
                                <option value="">No box</option>
                                {boxes.map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <SubmitButton variant="secondary">Set box</SubmitButton>
                          </ActionForm>
                        )}
                        {steel.length > 0 && (
                          <ActionForm action={post(`/api/products/${product.id}/steel`)} resetOnSuccess className={controlRow}>
                            <Field label="Pole">
                              <Select name="steelItemId" required defaultValue="" className="w-56">
                                <option value="" disabled>
                                  Pick a pole…
                                </option>
                                {steel.map((i) => (
                                  <option key={i.id} value={i.id}>
                                    {i.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field label="Per product" hint="0 removes it">
                              <Input name="qty" type="number" step="1" min="0" inputMode="numeric" className="w-24" required />
                            </Field>
                            <SubmitButton variant="secondary">Set poles</SubmitButton>
                          </ActionForm>
                        )}
                      </div>
                    </div>
                  )}
                >
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-semibold">{product.name}</span>
                    {product.sku && <span className="text-sm text-muted tabular-nums">{product.sku}</span>}
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-[1.3fr_1.2fr_1.2fr_0.6fr_1.5fr]">
                    <Fact label="Fabric">
                      {uses.length ? uses.map((u) => `${u.qty > 1 ? `${u.qty} × ` : ""}${u.material} ${u.label}`).join(" + ") : <span className="text-muted">None</span>}
                    </Fact>
                    <Fact label="Steel" wrap>
                      {parts.length ? (
                        <ul>
                          {parts.map((s) => (
                            <li key={s.steelItemId} className="tabular-nums">
                              {s.qty} × {s.name}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-muted">None</span>
                      )}
                    </Fact>
                    <Fact label="Box">{box ? box.name : <span className="font-semibold text-danger">Not set</span>}</Fact>
                    <Fact label="Packed">
                      <span className="tabular-nums">{product.shipWeightLb != null ? `${product.shipWeightLb} lb` : <span className="text-muted">—</span>}</span>
                    </Fact>
                    <Fact label="Sewing">
                      {product.sewCostInHouse != null || product.sewCostSummit != null ? (
                        <span className="tabular-nums">
                          {formatMoney(product.sewCostInHouse)} in-house, {formatMoney(product.sewCostSummit)} Summit
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Fact>
                  </dl>
                </EditableRow>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
