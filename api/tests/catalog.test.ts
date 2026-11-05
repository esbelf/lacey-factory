import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { loadCatalog } from "../src/domain/catalog";
import { listCutSizes, listProducts } from "../src/domain/queries";
import * as svc from "../src/domain/services";

let db: DB;

beforeAll(async () => {
  const client = new PGlite();
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "drizzle" });
  db = pg as unknown as DB;
});

describe("LakeMat catalog", () => {
  it("adds the four materials, 13 sizes and 15 products", async () => {
    expect(await loadCatalog(db)).toEqual({ materials: 4, sizes: 13, products: 15, components: 18, suppliers: 1 });
  });

  it("adds nothing the second time", async () => {
    expect(await loadCatalog(db)).toEqual({ materials: 0, sizes: 0, products: 0, components: 0, suppliers: 0 });
  });

  it("loads sizes switched off, and doesn't overwrite a cut length set later", async () => {
    const sizes = await listCutSizes(db);
    expect(sizes.every((s) => !s.size.active)).toBe(true);
    const hpg6 = sizes.find((s) => s.materialName === "TerraTex HPG-57" && s.size.label === "6x14")!;
    expect(hpg6.size).toMatchObject({ widthFt: 14, cutLengthFt: 6 });
    expect(sizes.find((s) => s.materialName === "TerraGrid RX1100")!.requiresSewing).toBe(false);

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
