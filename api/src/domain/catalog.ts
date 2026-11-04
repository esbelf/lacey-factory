import { and, eq } from "drizzle-orm";

import { CATALOG_MATERIALS, CATALOG_PRODUCTS } from "../db/catalog";
import { cutSizes, materials, productComponents, products } from "../db/schema";
import type { DB } from "../db/types";

export type CatalogResult = { materials: number; sizes: number; products: number; components: number };

/**
 * Adds Lacey's catalog (materials, cut sizes, products) where missing.
 * Safe to run any number of times: existing rows are left exactly as they are,
 * so cut lengths entered in Settings are never overwritten.
 * New sizes are added switched off until their real cut length is entered.
 */
export async function loadCatalog(db: DB): Promise<CatalogResult> {
  return db.transaction(async (tx) => {
    const added: CatalogResult = { materials: 0, sizes: 0, products: 0, components: 0 };
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
    return added;
  });
}
