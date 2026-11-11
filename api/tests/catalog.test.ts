import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { loadCatalog } from "../src/domain/catalog";
import { listCutSizes, listProducts, updateProductShipping } from "../src/domain/queries";
import { setProductBox } from "../src/domain/steel";
import * as svc from "../src/domain/services";

let db: DB;

beforeAll(async () => {
  const client = new PGlite();
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "drizzle" });
  db = pg as unknown as DB;
});

describe("LakeMat catalog", () => {
  it("adds the four materials, 30 sizes, 44 products and 12 boxes", async () => {
    expect(await loadCatalog(db)).toEqual({ materials: 4, sizes: 30, products: 44, components: 18, suppliers: 1, boxes: 12, parts: 3 });
  });

  it("adds nothing the second time", async () => {
    expect(await loadCatalog(db)).toEqual({ materials: 0, sizes: 0, products: 0, components: 0, suppliers: 0, boxes: 0, parts: 0 });
  });

  it("gives every product its SKU, box and packed weight, without overwriting edits", async () => {
    const byName = Object.fromEntries((await listProducts(db)).map((p) => [p.product.name, p]));
    expect(byName["LakeMat XL"]).toMatchObject({ product: { sku: "LM 24", shipWeightLb: 63 }, box: { name: "LAKEMAT BOX", qty: 1 }, steel: [] });
    expect(byName["SandMat 12x70"]).toMatchObject({ product: { sku: "SM 12x70" }, box: { name: "BOATLIFT BOX" }, uses: [] });
    expect(byName["Boatlift Mat OneSetOfLegs"].product.sku).toBe("BL HALF EXTREME");
    expect(byName["Hydrilla Large 19'"].product.shipWeightLb).toBeNull();
    expect(Object.values(byName).every((p) => p.box)).toBe(true);

    // Changed in Settings, then the catalog is loaded again: the edit stays.
    const [dock] = await db.select().from(schema.steelItems).where(eq(schema.steelItems.name, "DOCKMAT BOX"));
    await setProductBox(db, { productId: byName["LakeMat XL"].product.id, boxId: dock.id });
    await updateProductShipping(db, byName["LakeMat XL"].product.id, { sku: "LM-24X", shipWeightLb: 64 });
    await loadCatalog(db);
    const again = (await listProducts(db)).find((p) => p.product.name === "LakeMat XL")!;
    expect(again).toMatchObject({ product: { sku: "LM-24X", shipWeightLb: 64 }, box: { name: "DOCKMAT BOX" } });
    await expect(updateProductShipping(db, byName["LakeMat L"].product.id, { sku: "LM-24X", shipWeightLb: null })).rejects.toThrow(
      /already used by LakeMat XL/,
    );
  });

  it("loads sizes switched off, and doesn't overwrite a cut length set later", async () => {
    const sizes = await listCutSizes(db);
    expect(sizes.every((s) => !s.size.active)).toBe(true);
    const hpg6 = sizes.find((s) => s.materialName === "TerraTex HPG-57" && s.size.label === "6x14")!;
    expect(hpg6.size).toMatchObject({ widthFt: 14, cutLengthFt: 6 });
    expect(sizes.find((s) => s.materialName === "TerraGrid RX1100")!.requiresSewing).toBe(false);
    // N06 is sewn for LakeMat but not for SandMat.
    const n06 = (label: string) => sizes.find((s) => s.materialName === "TerraTex N06" && s.size.label === label)!;
    expect(n06("12x24").requiresSewing).toBe(true);
    expect(n06("12x20").requiresSewing).toBe(false);
    expect(n06("7x100").requiresSewing).toBe(false);

    await svc.updateCutSize(db, hpg6.size.id, { cutLengthFt: 6.5, active: true });
    await loadCatalog(db);
    const again = (await listCutSizes(db)).find((s) => s.size.id === hpg6.size.id)!;
    expect(again.size).toMatchObject({ cutLengthFt: 6.5, active: true });
  });

  it("can't cut a size that is still switched off", async () => {
    const sizes = await listCutSizes(db);
    const n06 = sizes.find((s) => s.materialName === "TerraTex N06" && s.size.label === "12x24")!;
    const roll = await svc.createRoll(db, "eric@lakemat.com", {
      materialId: n06.size.materialId,
      widthFt: 12,
      lengthFt: 300,
      receivedOn: "2026-10-28",
    });
    await expect(
      svc.recordCut(db, "eric@lakemat.com", { rollId: roll.id, cutOn: "2026-10-28", lines: [{ cutSizeId: n06.size.id, qty: 1 }] }),
    ).rejects.toThrow("Size 12x24 is turned off in settings.");
  });

  it("records what each product uses", async () => {
    const uses = Object.fromEntries(
      (await listProducts(db)).map((p) => [p.product.name, p.uses.map((u) => `${u.qty}×${u.material} ${u.label}`).sort()]),
    );
    expect(uses["MuckMat XL"]).toEqual(["1×TerraGrid RX1100 12x24", "1×TerraTex N06 12x24"]);
    expect(uses["LakeMat XL"]).toEqual(["1×TerraTex N06 12x24"]);
    expect(uses["Boatlift Mat Extreme"]).toEqual(["2×TerraTex HPG-57 6x14"]);
    expect(uses["Boatlift Mat OneSetOfLegs"]).toEqual(["1×TerraTex HPG-57 6x14"]);
    expect(uses["DockMat Extra Wide"]).toEqual(["1×TerraTex HPG-57 9x14"]);
    expect(uses["Boatlift Mat Pontoon"]).toEqual(["1×TerraTex HPG-57 24x14"]);
  });
});
