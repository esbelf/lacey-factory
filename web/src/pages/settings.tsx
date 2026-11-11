import { formatFeet } from "@lacey-factory/shared/feet";
import clsx from "clsx";
import { Link, useSearchParams } from "react-router";

import { patch, post, useApi, type ReadData } from "../api";
import { ActionForm, SubmitButton } from "../components/action-form";
import { ChannelSkusCard } from "../components/channel-skus-card";
import { Loading } from "../components/loading";
import { AddPanel, ChipTabs, CutDiagram, EditableRow, OffTag, SectionHeader, controlRow } from "../components/settings-ui";
import { ProductsCard, SteelItemsCard } from "../components/steel-cards";
import { SuppliersCard } from "../components/suppliers-card";
import { Empty, Field, Input, PageHeader, Select } from "../components/ui";
import { useCan } from "../me";
import { useTitle } from "../title";

type Material = ReadData<"materials">[number];
type SizeRow = ReadData<"cutSizes">[number];
type Section = { id: string; label: string; count?: number };

export function SettingsPage() {
  useTitle("Settings");
  const materialsQ = useApi("materials");
  const sizesQ = useApi("cutSizes");
  const productsQ = useApi("products");
  const steelQ = useApi("steel");
  const suppliersQ = useApi("suppliers");
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

  const groups: { label: string; sections: Section[] }[] = [
    {
      label: "What we cut",
      sections: [
        { id: "materials", label: "Materials", count: materials.length },
        { id: "sizes", label: "Cut sizes", count: sizes.length },
      ],
    },
    {
      label: "What we sell",
      sections: [
        { id: "products", label: "Products", count: products.length },
        ...(skusQ.data ? [{ id: "skus", label: "Amazon & Shopify SKUs", count: skusQ.data.length }] : []),
      ],
    },
    {
      label: "What we stock",
      sections: [
        { id: "steel", label: "Steel poles", count: steelItems.filter((i) => i.kind === "steel").length },
        { id: "boxes", label: "Boxes", count: steelItems.filter((i) => i.kind === "box").length },
        { id: "parts", label: "Parts", count: steelItems.filter((i) => i.kind === "part").length },
      ],
    },
    { label: "Who invoices us", sections: [{ id: "suppliers", label: "Suppliers", count: suppliersQ.data?.length }] },
  ];
  const all = groups.flatMap((g) => g.sections);
  const tab = all.some((t) => t.id === params.get("tab")) ? params.get("tab")! : all[0].id;

  return (
    <>
      <PageHeader title="Settings" subtitle="What the factory cuts, sells and stocks, and who sends us invoices." />

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="-mx-4 lg:sticky lg:top-4 lg:mx-0">
          <div className="flex gap-1 overflow-x-auto border-b border-line px-4 lg:flex-col lg:gap-5 lg:overflow-visible lg:border-0 lg:px-0">
            {groups.map((g) => (
              <div key={g.label} className="contents lg:block">
                <h2 className="mb-1 hidden px-3 text-xs font-semibold text-muted lg:block">{g.label}</h2>
                <ul className="contents lg:flex lg:flex-col lg:gap-0.5">
                  {g.sections.map((s) => (
                    <li key={s.id} className="shrink-0">
                      <RailLink section={s} active={s.id === tab} first={s.id === all[0].id} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <CatalogLoader className="mt-8 hidden lg:block" />
        </nav>

        <div className="min-w-0">
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {tab === "materials" && <MaterialsSection materials={materials} sizes={sizes} />}
            {tab === "sizes" && (
              <SizesSection
                materials={materials}
                sizes={sizes}
                materialParam={params.get("material")}
                onMaterial={(id) => setParams({ tab: "sizes", material: id }, { replace: true })}
              />
            )}
            {tab === "products" && <ProductsCard products={products} steelItems={steelItems} canEdit={can("settings")} />}
            {tab === "steel" && <SteelItemsCard items={steelItems} />}
            {tab === "boxes" && <SteelItemsCard items={steelItems} kind="box" />}
            {tab === "parts" && <SteelItemsCard items={steelItems} kind="part" />}
            {tab === "suppliers" && <SuppliersCard materials={materials} steelItems={steelItems} />}
            {tab === "skus" && skusQ.data && <ChannelSkusCard skus={skusQ.data} products={products} />}
          </div>
          <CatalogLoader className="mt-8 lg:hidden" />
        </div>
      </div>
    </>
  );
}

function RailLink({ section, active, first }: { section: Section; active: boolean; first: boolean }) {
  return (
    <Link
      to={first ? "?" : `?tab=${section.id}`}
      replace
      aria-current={active ? "page" : undefined}
      className={clsx(
        "relative flex items-center justify-between gap-3 rounded-md px-3 py-2.5 font-semibold whitespace-nowrap",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        active ? "text-ink lg:bg-surface lg:shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-x-3 bottom-0 h-[3px] rounded-full bg-accent lg:inset-x-auto lg:top-2 lg:bottom-2 lg:left-0 lg:h-auto lg:w-[3px]"
        />
      )}
      {section.label}
      {section.count != null && <span className="text-sm font-medium text-muted tabular-nums">{section.count}</span>}
    </Link>
  );
}

function CatalogLoader({ className }: { className?: string }) {
  return (
    <div className={clsx("px-3 text-sm text-muted", className)}>
      <h2 className="font-semibold text-ink">LakeMat catalog</h2>
      <p className="mt-1">
        Adds our standard materials, sizes, products, boxes and the Hanes supplier. Only adds what&apos;s missing and never
        changes what&apos;s here.
      </p>
      <ActionForm action={post("/api/catalog/load")} className="mt-3">
        <SubmitButton variant="secondary">Load catalog</SubmitButton>
      </ActionForm>
    </div>
  );
}

function MaterialsSection({ materials, sizes }: { materials: Material[]; sizes: SizeRow[] }) {
  return (
    <>
      <SectionHeader title="Materials">
        What comes in on rolls. Whether new sizes get sewn is only a default; each cut size decides for itself.
      </SectionHeader>
      {materials.length === 0 ? (
        <div className="p-6">
          <Empty>No materials yet. Add one below or load the LakeMat catalog.</Empty>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {materials.map((m) => {
            const count = sizes.filter((s) => s.size.materialId === m.id).length;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3.5 sm:px-6">
                <div className={clsx("min-w-48 flex-1", !m.active && "opacity-55")}>
                  <div className="font-semibold">
                    {m.name}
                    {!m.active && <OffTag />}
                  </div>
                  <div className="text-sm text-muted">
                    {m.requiresSewing ? "New sizes get sewn" : "New sizes go straight to inventory"}
                  </div>
                </div>
                <div className="w-28 text-sm">
                  <div className="text-xs text-muted">Usual width</div>
                  <div className="tabular-nums">{m.defaultWidthFt != null ? formatFeet(m.defaultWidthFt) : "Not set"}</div>
                </div>
                <Link
                  to={`?tab=sizes&material=${m.id}`}
                  className="w-24 text-sm font-semibold text-brand underline-offset-2 hover:underline"
                >
                  {count === 1 ? "1 size" : `${count} sizes`}
                </Link>
                <ActionForm action={patch(`/api/materials/${m.id}`)}>
                  <input type="hidden" name="active" value={String(!m.active)} />
                  <SubmitButton variant="ghost">{m.active ? "Turn off" : "Turn on"}</SubmitButton>
                </ActionForm>
              </li>
            );
          })}
        </ul>
      )}
      <AddPanel label="Add material">
        {(close) => (
          <ActionForm action={post("/api/materials")} resetOnSuccess onSuccess={close} className={controlRow}>
            <Field label="Name">
              <Input name="name" placeholder="e.g. Hanes weed barrier" className="w-64" required />
            </Field>
            <Field label="Usual roll width (ft)">
              <Input name="defaultWidthFt" type="number" step="0.01" min="0" inputMode="decimal" placeholder="12.5" className="w-36" />
            </Field>
            <label className="flex h-11 items-center gap-2">
              <input type="checkbox" name="requiresSewing" defaultChecked className="h-5 w-5" />
              New sizes get sewn
            </label>
            <SubmitButton>Add material</SubmitButton>
          </ActionForm>
        )}
      </AddPanel>
    </>
  );
}

function SizesSection({
  materials,
  sizes,
  materialParam,
  onMaterial,
}: {
  materials: Material[];
  sizes: SizeRow[];
  materialParam: string | null;
  onMaterial: (id: string) => void;
}) {
  // One chip per material that has sizes or can get new ones.
  const shown = materials.filter((m) => m.active || sizes.some((s) => s.size.materialId === m.id));
  if (shown.length === 0) {
    return (
      <>
        <SectionHeader title="Cut sizes" />
        <div className="p-6">
          <Empty>Add a material first.</Empty>
        </div>
      </>
    );
  }
  const material = shown.find((m) => m.id === materialParam) ?? shown[0];
  const materialSizes = sizes.filter((s) => s.size.materialId === material.id);
  // One scale for the whole material so pieces compare by eye. A rare long piece
  // (a 100' SandMat roll) shouldn't shrink the rest, so scale to typical lengths
  // and let the diagram break anything longer.
  const lengths = materialSizes.map((s) => s.size.cutLengthFt).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 1;
  const maxLength = Math.max(1, Math.min(lengths.at(-1) ?? 1, median * 2));
  const maxWidth = Math.max(1, ...materialSizes.map((s) => s.size.widthFt));
  const scale = Math.min(150 / maxLength, 48 / maxWidth);

  return (
    <>
      <SectionHeader title="Cut sizes">
        What the crew cuts off each roll. Pieces are drawn to scale; a stitched edge means the size gets sewn. Changing a
        cut length only affects future cuts.
      </SectionHeader>
      <ChipTabs
        label="Materials"
        value={material.id}
        onChange={onMaterial}
        items={shown.map((m) => ({
          id: m.id,
          label: m.name,
          count: sizes.filter((s) => s.size.materialId === m.id).length,
          dim: !m.active,
        }))}
      />
      {materialSizes.length === 0 ? (
        <div className="p-6">
          <Empty>No sizes for {material.name} yet.</Empty>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {materialSizes.map(({ size }) => (
            <EditableRow
              key={size.id}
              dim={!size.active}
              editor={(close) => (
                <ActionForm action={patch(`/api/cut-sizes/${size.id}`)} onSuccess={close} className={controlRow}>
                  <Field label="Cut length (ft)" hint="Off the roll, with hems">
                    <Input name="cutLengthFt" type="number" step="0.01" min="0" inputMode="decimal" defaultValue={size.cutLengthFt} className="w-32" required />
                  </Field>
                  <Field label="Used for">
                    <Input name="productFamily" defaultValue={size.productFamily ?? ""} className="w-52" />
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
                  <SubmitButton>Save</SubmitButton>
                  {!size.active && (
                    <p className="basis-full text-sm text-muted">Turned off. Check the cut length (with hems), tick Active and save to cut it again.</p>
                  )}
                  {size.requiresSewing && (
                    <p className="basis-full text-sm text-muted">
                      Unticking “Gets sewn” moves this size&apos;s pieces waiting to be sewn into inventory.
                    </p>
                  )}
                </ActionForm>
              )}
            >
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div className="flex w-40 items-center">
                  <CutDiagram widthFt={size.widthFt} lengthFt={size.cutLengthFt} scale={scale} sewn={size.requiresSewing} maxPx={150} />
                </div>
                <div className="w-36">
                  <div className="text-lg leading-tight font-semibold tabular-nums">
                    {size.label}
                    {!size.active && <OffTag />}
                  </div>
                  <div className="text-sm text-muted">{size.requiresSewing ? "Gets sewn" : "Straight to inventory"}</div>
                </div>
                <div className="w-24 text-sm">
                  <div className="text-xs text-muted">Cut length</div>
                  <div className="tabular-nums">
                    {formatFeet(size.cutLengthFt)} <span className="text-muted">× {formatFeet(size.widthFt)}</span>
                  </div>
                </div>
                <div className="min-w-32 flex-1 text-sm">
                  <div className="text-xs text-muted">Used for</div>
                  <div>{size.productFamily || <span className="text-muted">Not set</span>}</div>
                </div>
              </div>
            </EditableRow>
          ))}
        </ul>
      )}
      {!material.active ? (
        <p className="border-t border-line px-4 py-4 text-sm text-muted sm:px-6">
          {material.name} is turned off. Turn it on under Materials to add sizes.
        </p>
      ) : (
        <AddPanel label={`Add ${material.name} size`}>
          {(close) => (
            <ActionForm action={post("/api/cut-sizes")} resetOnSuccess onSuccess={close} className={controlRow}>
              <input type="hidden" name="materialId" value={material.id} />
              <Field label="Label" hint="What the crew calls it, e.g. 12x24">
                <Input name="label" className="w-36" required />
              </Field>
              <Field label="Width (ft)">
                <Input name="widthFt" type="number" step="0.01" min="0" inputMode="decimal" className="w-28" required />
              </Field>
              <Field label="Cut length (ft)" hint="Off the roll, e.g. 26">
                <Input name="cutLengthFt" type="number" step="0.01" min="0" inputMode="decimal" className="w-32" required />
              </Field>
              <Field label="Used for">
                <Input name="productFamily" placeholder="e.g. LakeMat / MuckMat XL" className="w-52" />
              </Field>
              <Field label="Order">
                <Input name="sortOrder" type="number" step="1" defaultValue={0} className="w-20" />
              </Field>
              <Field label="Sewing">
                <Select name="sewing" defaultValue="" className="w-60">
                  <option value="">Same as the material</option>
                  <option value="sewn">Gets sewn</option>
                  <option value="not_sewn">Not sewn, straight to inventory</option>
                </Select>
              </Field>
              <SubmitButton>Add size</SubmitButton>
            </ActionForm>
          )}
        </AddPanel>
      )}
    </>
  );
}
