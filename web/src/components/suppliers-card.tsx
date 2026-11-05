import { formatFeet } from "@lacey-factory/shared/feet";

import { patch, post, type SteelData, type Supplier, useApi } from "../api";
import { ActionForm, SubmitButton } from "./action-form";
import { Card, Empty, Field, Input, Select } from "./ui";

type Material = {
  id: string;
  name: string;
  active: boolean;
  defaultWidthFt: number | null;
};

const KIND_LABEL = { rolls: "Rolls", steel: "Steel" } as const;

/** Settings → Suppliers: who sends us invoices, and how their products map to our rolls or steel poles. */
export function SuppliersCard({
  materials,
  steelItems,
}: {
  materials: Material[];
  steelItems: SteelData["items"];
}) {
  const { data: suppliers } = useApi("suppliers");
  const active = materials.filter((m) => m.active);

  return (
    <Card title="Suppliers (invoice emails)" className="lg:col-span-2">
      <p className="mb-4 text-sm text-muted">
        Emails to eric@lakemat.com from these addresses are read automatically.
        For a rolls supplier, each product code below turns invoice lines into
        rolls; for a steel supplier, into steel poles with their cost. Invoices
        with codes not listed here go to the Inbox for review.
      </p>
      {!suppliers ? null : suppliers.length === 0 ? (
        <Empty>
          No suppliers yet. Load the LakeMat catalog or add one below.
        </Empty>
      ) : (
        <ul className="flex flex-col gap-4">
          {suppliers.map((s) => (
            <li
              key={s.id}
              className={`rounded-lg border border-line p-3 ${s.active ? "" : "opacity-60"}`}
            >
              <ActionForm
                action={patch(`/api/suppliers/${s.id}`)}
                className="flex flex-wrap items-end gap-3"
              >
                <Field label="Supplier">
                  <Input
                    name="name"
                    defaultValue={s.name}
                    className="w-56"
                    required
                  />
                </Field>
                <Field
                  label="Sends from (emails or @domain)"
                  hint="e.g. billing@hanesgeo.com, @hanesgeo.com"
                >
                  <Input
                    name="emailPatterns"
                    defaultValue={s.emailPatterns.join(", ")}
                    className="w-80"
                    placeholder="Not set — emails won't match"
                  />
                </Field>
                <label className="flex h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    name="active"
                    defaultChecked={s.active}
                    className="h-5 w-5"
                  />{" "}
                  Active
                </label>
                <span className="flex h-11 items-center rounded-full bg-line px-3 text-sm font-semibold">
                  {KIND_LABEL[s.kind]}
                </span>
                <SubmitButton variant="secondary">Save</SubmitButton>
              </ActionForm>

              {s.kind === "steel" ? (
                <SteelMappings supplier={s} steelItems={steelItems} />
              ) : (
                <div className="mt-3">
                  <div className="mb-1 text-sm font-semibold text-muted">
                    Products
                  </div>
                  {s.products.length === 0 ? (
                    <p className="text-sm text-muted">None yet.</p>
                  ) : (
                    <ul className="divide-y divide-line text-sm">
                      {s.products.map(({ product, materialName }) => (
                        <li
                          key={product.id}
                          className="flex flex-wrap items-center gap-3 py-1.5"
                        >
                          <span className="w-24 font-semibold">
                            {product.productCode ?? "—"}
                          </span>
                          <span className="flex-1">
                            {materialName} {formatFeet(product.widthFt)} ×{" "}
                            {formatFeet(product.lengthFt)}
                            {product.descriptionMatch && (
                              <span className="text-muted">
                                {" "}
                                · matches “{product.descriptionMatch}”
                              </span>
                            )}
                          </span>
                          <ActionForm
                            action={post(
                              `/api/supplier-products/${product.id}/delete`,
                            )}
                            confirm="Remove this product mapping?"
                          >
                            <SubmitButton variant="ghost">Remove</SubmitButton>
                          </ActionForm>
                        </li>
                      ))}
                    </ul>
                  )}
                  <ActionForm
                    action={post(`/api/suppliers/${s.id}/products`)}
                    resetOnSuccess
                    className="mt-2 flex flex-wrap items-end gap-2"
                  >
                    <Field label="Product code">
                      <Input
                        name="productCode"
                        placeholder="38151"
                        className="w-28"
                      />
                    </Field>
                    <Field label="Or description contains">
                      <Input
                        name="descriptionMatch"
                        placeholder="TERRATEX N06"
                        className="w-40"
                      />
                    </Field>
                    <Field label="Material">
                      <Select
                        name="materialId"
                        required
                        defaultValue=""
                        className="w-48"
                      >
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
                      <Input
                        name="widthFt"
                        type="number"
                        step="0.01"
                        min="0"
                        inputMode="decimal"
                        className="w-24"
                        required
                      />
                    </Field>
                    <Field label="Length (ft)">
                      <Input
                        name="lengthFt"
                        type="number"
                        step="0.01"
                        min="0"
                        inputMode="decimal"
                        className="w-24"
                        required
                      />
                    </Field>
                    <SubmitButton variant="secondary">Add product</SubmitButton>
                  </ActionForm>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ActionForm
        action={post("/api/suppliers")}
        resetOnSuccess
        className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4"
      >
        <Field label="New supplier">
          <Input
            name="name"
            placeholder="e.g. Hanes Geo Components"
            className="w-56"
            required
          />
        </Field>
        <Field label="Sends from">
          <Input
            name="emailPatterns"
            placeholder="billing@supplier.com, @supplier.com"
            className="w-80"
            required
          />
        </Field>
        <Field label="Supplies">
          <Select name="kind" defaultValue="rolls" className="w-32">
            <option value="rolls">Rolls</option>
            <option value="steel">Steel</option>
          </Select>
        </Field>
        <SubmitButton>Add supplier</SubmitButton>
      </ActionForm>
    </Card>
  );
}

function SteelMappings({
  supplier,
  steelItems,
}: {
  supplier: Supplier;
  steelItems: SteelData["items"];
}) {
  const active = steelItems.filter((i) => i.active);
  return (
    <div className="mt-3">
      <div className="mb-1 text-sm font-semibold text-muted">
        Steel products
      </div>
      {supplier.steelProducts.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {supplier.steelProducts.map(({ product, steelItemName }) => (
            <li
              key={product.id}
              className="flex flex-wrap items-center gap-3 py-1.5"
            >
              <span className="w-24 font-semibold">
                {product.productCode ?? "—"}
              </span>
              <span className="flex-1">
                {steelItemName}
                {product.descriptionMatch && (
                  <span className="text-muted">
                    {" "}
                    · matches “{product.descriptionMatch}”
                  </span>
                )}
              </span>
              <ActionForm
                action={post(
                  `/api/supplier-steel-products/${product.id}/delete`,
                )}
                confirm="Remove this product mapping?"
              >
                <SubmitButton variant="ghost">Remove</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      {active.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          Add pole types under Steel poles first.
        </p>
      ) : (
        <ActionForm
          action={post(`/api/suppliers/${supplier.id}/steel-products`)}
          resetOnSuccess
          className="mt-2 flex flex-wrap items-end gap-2"
        >
          <Field label="Product code">
            <Input
              name="productCode"
              placeholder="SP-114-10"
              className="w-32"
            />
          </Field>
          <Field label="Or description contains">
            <Input
              name="descriptionMatch"
              placeholder={`1-1/4" GALV`}
              className="w-40"
            />
          </Field>
          <Field label="Pole">
            <Select
              name="steelItemId"
              required
              defaultValue=""
              className="w-56"
            >
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
          <SubmitButton variant="secondary">Add product</SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}
