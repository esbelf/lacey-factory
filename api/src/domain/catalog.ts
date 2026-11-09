import { and, eq, inArray } from "drizzle-orm";

import {
  CATALOG_BOXES,
  CATALOG_MATERIALS,
  CATALOG_PRODUCTS,
  CATALOG_PRODUCTS_WITHOUT_RECIPE,
  CATALOG_SHIPPING,
  CATALOG_SUPPLIERS,
} from "../db/catalog";
import { cutSizes, materials, productComponents, products, productSteel, steelItems, supplierProducts, suppliers } from "../db/schema";
import type { DB } from "../db/types";

export type CatalogResult = {
  materials: number;
  sizes: number;
  products: number;
  components: number;
  suppliers: number;
  boxes: number;
};

/**
 * Adds Lacey's catalog (materials, cut sizes, products) where missing.
 * Safe to run any number of times: existing rows are left exactly as they are,
 * so cut lengths entered in Settings are never overwritten.
 * New sizes are added switched off until their real cut length is entered.
 */
export async function loadCatalog(db: DB): Promise<CatalogResult> {
  return db.transaction(async (tx) => {
    const added: CatalogResult = { materials: 0, sizes: 0, products: 0, components: 0, suppliers: 0, boxes: 0 };
    const sizeId = new Map<string, string>(); // "material|label" → id

    for (const m of CATALOG_MATERIALS) {
      let [mat] = await tx.select().from(materials).where(eq(materials.name, m.name));
      if (!mat) {
        [mat] = await tx
          .insert(materials)
          .values({ name: m.name, requiresSewing: m.requiresSewing, defaultWidthFt: m.defaultWidthFt })
          .returning();
        added.materials++;
      }
      for (const [i, s] of m.sizes.entries()) {
        let [row] = await tx
          .select({ id: cutSizes.id })
          .from(cutSizes)
          .where(and(eq(cutSizes.materialId, mat.id), eq(cutSizes.label, s.label)));
        if (!row) {
          [row] = await tx
            .insert(cutSizes)
            .values({
              materialId: mat.id,
              label: s.label,
              widthFt: s.widthFt,
              cutLengthFt: s.finishedLengthFt,
              productFamily: s.usedFor,
              sortOrder: i + 1,
              active: false,
              requiresSewing: s.requiresSewing ?? m.requiresSewing,
            })
            .returning({ id: cutSizes.id });
          added.sizes++;
        }
        sizeId.set(`${m.name}|${s.label}`, row.id);
      }
    }

    for (const [i, p] of CATALOG_PRODUCTS.entries()) {
      let [prod] = await tx.select({ id: products.id }).from(products).where(eq(products.name, p.name));
      if (!prod) {
        [prod] = await tx
          .insert(products)
          .values({ name: p.name, productLine: p.productLine, sortOrder: i + 1 })
          .returning({ id: products.id });
        added.products++;
      }
      for (const u of p.uses) {
        const cutSizeId = sizeId.get(`${u.material}|${u.size}`);
        if (!cutSizeId) throw new Error(`Catalog error: ${p.name} uses unknown size ${u.material} ${u.size}`);
        const inserted = await tx
          .insert(productComponents)
          .values({ productId: prod.id, cutSizeId, qty: u.qty })
          .onConflictDoNothing()
          .returning({ id: productComponents.id });
        added.components += inserted.length;
      }
    }

    for (const sup of CATALOG_SUPPLIERS) {
      let [row] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, sup.name));
      if (!row) {
        [row] = await tx.insert(suppliers).values({ name: sup.name, kind: sup.kind }).returning({ id: suppliers.id });
        added.suppliers++;
      }
      for (const p of sup.products) {
        const [mat] = await tx.select({ id: materials.id }).from(materials).where(eq(materials.name, p.material));
        if (!mat) throw new Error(`Catalog error: ${sup.name} product ${p.productCode} uses unknown material ${p.material}`);
        await tx
          .insert(supplierProducts)
          .values({ supplierId: row.id, productCode: p.productCode, descriptionMatch: p.descriptionMatch, materialId: mat.id, widthFt: p.widthFt, lengthFt: p.lengthFt })
          .onConflictDoNothing();
      }
    }
    // Products whose recipe isn't known yet (no fabric pieces).
    for (const [i, p] of CATALOG_PRODUCTS_WITHOUT_RECIPE.entries()) {
      const inserted = await tx
        .insert(products)
        .values({ name: p.name, productLine: p.productLine, sortOrder: CATALOG_PRODUCTS.length + i + 1 })
        .onConflictDoNothing()
        .returning({ id: products.id });
      added.products += inserted.length;
    }

    // Shipping boxes.
    const boxId = new Map<string, string>();
    for (const [i, b] of CATALOG_BOXES.entries()) {
      let [row] = await tx.select({ id: steelItems.id }).from(steelItems).where(eq(steelItems.name, b.name));
      if (!row) {
        [row] = await tx.insert(steelItems).values({ ...b, kind: "box", sortOrder: i + 1 }).returning({ id: steelItems.id });
        added.boxes++;
      }
      boxId.set(b.name, row.id);
    }

    // SKU, weight and box: filled in only where still empty, so Settings edits stay.
    const allBoxIds = tx.select({ id: steelItems.id }).from(steelItems).where(eq(steelItems.kind, "box"));
    for (const s of CATALOG_SHIPPING) {
      const [prod] = await tx.select().from(products).where(eq(products.name, s.product));
      if (!prod) throw new Error(`Catalog error: shipping row for unknown product ${s.product}`);
      const patch: Partial<typeof products.$inferInsert> = {};
      if (prod.sku == null) {
        const [taken] = await tx.select({ id: products.id }).from(products).where(eq(products.sku, s.sku));
        if (!taken) patch.sku = s.sku;
      }
      if (prod.shipWeightLb == null && s.weightLb != null) patch.shipWeightLb = s.weightLb;
      if (Object.keys(patch).length) await tx.update(products).set(patch).where(eq(products.id, prod.id));

      const [hasBox] = await tx
        .select({ id: productSteel.id })
        .from(productSteel)
        .where(and(eq(productSteel.productId, prod.id), inArray(productSteel.steelItemId, allBoxIds)));
      const box = boxId.get(s.box);
      if (!box) throw new Error(`Catalog error: ${s.product} uses unknown box ${s.box}`);
      if (!hasBox) await tx.insert(productSteel).values({ productId: prod.id, steelItemId: box, qty: 1 });
    }
    return added;
  });
}
