import { formatFeet } from "@lacey-factory/shared/feet";
import { useSearchParams } from "react-router";

import { patch, post, useApi } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { Loading } from "../components/loading";
import { ChannelSkusCard } from "../components/channel-skus-card";
import { ProductsCard, SteelItemsCard } from "../components/steel-cards";
import { SuppliersCard } from "../components/suppliers-card";
import { Card, Empty, Field, Input, PageHeader, Select } from "../components/ui";
import { useCan } from "../me";
import { useTitle } from "../title";

export function SettingsPage() {
  useTitle("Settings");
  const materialsQ = useApi("materials");
  const sizesQ = useApi("cutSizes");
  const productsQ = useApi("products");
  const steelQ = useApi("steel");
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const skusQ = useApi("channelSkus", { enabled: can("orders") });
  if (!materialsQ.data || !sizesQ.data || !productsQ.data || !steelQ.data) {
    return <Loading error={materialsQ.error ?? sizesQ.error ?? productsQ.error ?? steelQ.error} />;
  }
  const steelItems = steelQ.data.items;
  const materials = materialsQ.data;
  const sizes = sizesQ.data;
  const products = productsQ.data;

  const tabs: { id: string; label: string }[] = [
    { id: "materials", label: "Materials" },
    { id: "sizes", label: "Cut sizes" },
    { id: "products", label: "Products" },
    { id: "steel", label: "Steel" },
    { id: "boxes", label: "Boxes" },
    { id: "suppliers", label: "Suppliers" },
    ...(skusQ.data ? [{ id: "skus", label: "Amazon & Shopify SKUs" }] : []),
  ];
  const tab = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : tabs[0].id;
  const twoColumns = "grid items-start gap-4 lg:grid-cols-[1fr_24rem]";

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Materials that come in on rolls and the sizes we cut from each, steel poles, shipping boxes, and what each product uses and ships in."
      />

      <div role="tablist" aria-label="Settings sections" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="settings-panel"
            onClick={() => setParams(t.id === tabs[0].id ? {} : { tab: t.id }, { replace: true })}
            className={`-mb-px border-b-2 px-4 py-2 font-semibold ${
              tab === t.id ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="settings-panel" aria-labelledby={`tab-${tab}`}>
        {tab === "materials" && (
          <div className={twoColumns}>
            <Card title="Materials">
              {materials.length === 0 ? (
                <Empty>No materials yet.</Empty>
              ) : (
                <ul className="divide-y divide-line">
                  {materials.map((m) => (
                    <li key={m.id} className={`flex items-center gap-3 py-3 ${m.active ? "" : "opacity-50"}`}>
                      <div className="flex-1">
                        <div className="font-semibold">{m.name}</div>
                        <div className="text-sm text-muted">
                          {m.requiresSewing ? "New sizes get sewn" : "New sizes aren't sewn — cuts go straight to inventory"}
                          {m.defaultWidthFt != null && ` · usual width ${formatFeet(m.defaultWidthFt)}`}
                        </div>
                      </div>
                      <ActionForm action={patch(`/api/materials/${m.id}`)}>
                        <input type="hidden" name="active" value={String(!m.active)} />
                        <SubmitButton variant="ghost">{m.active ? "Turn off" : "Turn on"}</SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Add material">
              <ActionForm action={post("/api/materials")} resetOnSuccess className="flex flex-col gap-3">
                <Field label="Name">
                  <Input name="name" placeholder="e.g. Hanes weed barrier" required />
                </Field>
                <Field label="Usual roll width (ft)">
                  <Input name="defaultWidthFt" type="number" step="0.01" min="0" inputMode="decimal" placeholder="12.5" />
                </Field>
                <label className="flex items-center gap-2 text-base">
                  <input type="checkbox" name="requiresSewing" defaultChecked className="h-5 w-5" />
                  New sizes get sewn (uncheck for geogrid)
                </label>
                <div>
                  <SubmitButton>Add material</SubmitButton>
                </div>
              </ActionForm>
            </Card>
            <Card title="LakeMat catalog">
              <p className="mb-3 text-base">
                Adds TerraTex N06, TerraGrid RX1100, TerraTex HD NTPEP and TerraTex HPG-57 with their sizes and products,
                and Hanes Geo Components as a roll supplier.
                Only adds what&apos;s missing. Never changes what&apos;s already here.
              </p>
              <ActionForm action={post("/api/catalog/load")}>
                <SubmitButton variant="secondary">Load LakeMat catalog</SubmitButton>
              </ActionForm>
            </Card>
          </div>
        )}

        {tab === "sizes" && (
          <div className={twoColumns}>
            <Card title="Cut sizes">
              {sizes.length === 0 ? (
                <Empty>No sizes yet.</Empty>
              ) : (
                <ul className="flex flex-col gap-2">
                  {sizes.map(({ size, materialName }) => (
                    <li key={size.id} className="rounded-lg border border-line p-3">
                      <ActionForm action={patch(`/api/cut-sizes/${size.id}`)} className="flex flex-wrap items-end gap-3">
                        <div className="min-w-32">
                          <div className="text-lg font-semibold">{size.label}</div>
                          <div className="text-sm text-muted">
                            {materialName} · {formatFeet(size.widthFt)} wide
                          </div>
                          <div className="text-sm text-muted">
                            {size.requiresSewing ? "Gets sewn" : "Not sewn — cuts go straight to inventory"}
                          </div>
                          {!size.active && (
                            <div className="text-sm font-semibold text-danger">
                              Off — enter the cut length (with hems), tick Active, Save
                            </div>
                          )}
                        </div>
                        <Field label="Cut length (ft)">
                          <Input
                            name="cutLengthFt"
                            type="number"
                            step="0.01"
                            min="0"
                            defaultValue={size.cutLengthFt}
                            className="w-28"
                            required
                          />
                        </Field>
                        <Field label="Used for">
                          <Input name="productFamily" defaultValue={size.productFamily ?? ""} className="w-48" />
                        </Field>
                        <Field label="Order">
                          <Input name="sortOrder" type="number" step="1" defaultValue={size.sortOrder} className="w-20" />
                        </Field>
                        <label className="flex h-11 items-center gap-2">
                          <input type="checkbox" name="active" defaultChecked={size.active} className="h-5 w-5" /> Active
                        </label>
                        <label className="flex h-11 items-center gap-2">
                          <input type="checkbox" name="requiresSewing" defaultChecked={size.requiresSewing} className="h-5 w-5" /> Gets sewn
                        </label>
                        <SubmitButton variant="secondary">Save</SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-sm text-muted">
                Changing a cut length only affects future cuts. Unticking "Gets sewn" moves that size's pieces waiting to be
                sewn into inventory.
              </p>
            </Card>
            <Card title="Add cut size">
              {materials.length === 0 ? (
                <p className="text-muted">Add a material first.</p>
              ) : (
                <ActionForm action={post("/api/cut-sizes")} resetOnSuccess className="flex flex-col gap-3">
                  <Field label="Material">
                    <Select name="materialId" required>
                      {materials
                        .filter((m) => m.active)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="Label" hint="How the crew calls it, e.g. 12x24">
                    <Input name="label" required />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Width (ft)">
                      <Input name="widthFt" type="number" step="0.01" min="0" inputMode="decimal" required />
                    </Field>
                    <Field label="Cut length (ft)" hint="Off the roll, e.g. 26">
                      <Input name="cutLengthFt" type="number" step="0.01" min="0" inputMode="decimal" required />
                    </Field>
                  </div>
                  <Field label="Used for">
                    <Input name="productFamily" placeholder="e.g. LakeMat / MuckMat XL" />
                  </Field>
                  <Field label="Order">
                    <Input name="sortOrder" type="number" step="1" defaultValue={0} />
                  </Field>
                  <Field label="Sewing">
                    <Select name="sewing" defaultValue="">
                      <option value="">Same as the material</option>
                      <option value="sewn">Gets sewn</option>
                      <option value="not_sewn">Not sewn — straight to inventory</option>
                    </Select>
                  </Field>
                  <div>
                    <SubmitButton>Add size</SubmitButton>
                  </div>
                </ActionForm>
              )}
            </Card>
          </div>
        )}

        {tab === "products" && <ProductsCard products={products} steelItems={steelItems} canEdit={can("settings")} />}
        {tab === "steel" && <SteelItemsCard items={steelItems} />}
        {tab === "boxes" && <SteelItemsCard items={steelItems} kind="box" />}
        {tab === "suppliers" && <SuppliersCard materials={materials} steelItems={steelItems} />}
        {tab === "skus" && skusQ.data && <ChannelSkusCard skus={skusQ.data} products={products} />}
      </div>
    </>
  );
}
