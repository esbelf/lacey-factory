import { patch, post, type Product, type SteelData } from "../api";
import { ActionForm, SubmitButton } from "./action-form";
import { Card, Empty, Field, Input, Select } from "./ui";

type SteelItem = SteelData["items"][number];

/** Settings → Steel poles: the pole types we stock. */
export function SteelItemsCard({ items }: { items: SteelItem[] }) {
  return (
    <Card title="Steel poles">
      <p className="mb-3 text-sm text-muted">
        Pole types we stock, counted by the piece. Map a steel supplier&apos;s product codes to these under Suppliers.
      </p>
      {items.length === 0 ? (
        <Empty>No steel items yet.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((i) => (
            <li key={i.id} className={`rounded-lg border border-line p-3 ${i.active ? "" : "opacity-60"}`}>
              <ActionForm action={patch(`/api/steel-items/${i.id}`)} className="flex flex-wrap items-end gap-3">
                <Field label="Name">
                  <Input name="name" defaultValue={i.name} className="w-64" required />
                </Field>
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
        <Field label="New pole type">
          <Input name="name" placeholder={`e.g. 1-1/4" × 10' galvanized`} className="w-64" required />
        </Field>
        <Field label="Order">
          <Input name="sortOrder" type="number" step="1" defaultValue={0} className="w-20" />
        </Field>
        <SubmitButton>Add pole type</SubmitButton>
      </ActionForm>
    </Card>
  );
}

/** Settings → Products: what each product uses, with its steel editable here. */
export function ProductsCard({ products, steelItems, canEdit }: { products: Product[]; steelItems: SteelItem[]; canEdit: boolean }) {
  const active = steelItems.filter((i) => i.active);
  return (
    <Card title="Products">
      {products.length === 0 ? (
        <Empty>No products yet. Load the LakeMat catalog to add them.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {products.map(({ product, uses, steel }) => (
            <li key={product.id} className="py-3">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-semibold">{product.name}</span>
                <span className="text-sm text-muted">
                  {uses.map((u) => `${u.qty > 1 ? `${u.qty} × ` : ""}${u.material} ${u.label}`).join(" + ") || "No fabric"}
                </span>
              </div>
              <div className="mt-1 text-sm">
                Steel: {steel.length ? steel.map((s) => `${s.qty} × ${s.name}`).join(" + ") : <span className="text-muted">none</span>}
              </div>
              {canEdit && active.length > 0 && (
                <ActionForm action={post(`/api/products/${product.id}/steel`)} resetOnSuccess className="mt-2 flex flex-wrap items-end gap-2">
                  <Field label="Pole">
                    <Select name="steelItemId" required defaultValue="" className="w-56">
                      <option value="" disabled>
                        Pick…
                      </option>
                      {active.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Per product" hint="0 removes it">
                    <Input name="qty" type="number" step="1" min="0" inputMode="numeric" className="w-24" required />
                  </Field>
                  <SubmitButton variant="secondary">Set</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-muted">
        Nothing is set aside for a product until it sells. A sale takes out the steel and fabric listed here.
        LakeMat and MuckMat draw from the same sewn N06 pieces.
      </p>
    </Card>
  );
}
