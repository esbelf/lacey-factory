// Product sales. recordSale is the one entry point for every sales channel
// (manual today; Shopify, Amazon and other APIs later): it takes the product's
// steel and shipping box (oldest lots first) and fabric pieces (oldest cut
// first) out of stock.
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import {
  cutSizes,
  inventoryAdjustments,
  pieces,
  productComponents,
  products,
  productSteel,
  sales,
  steelItems,
  steelLots,
  steelUsage,
} from "../db/schema";
import type { DB } from "../db/types";
import { UserError } from "./errors";
import { lockSteelItems, refreshSaleCost, settleShortages, takeSteel } from "./steel";

export type SaleSource = (typeof sales.$inferSelect)["source"];
export type Sale = typeof sales.$inferSelect;

/**
 * Records a sale and uses up its materials, in one transaction. A sale is never
 * refused for lack of stock (the order already happened): missing steel is
 * recorded as short and filled from the next delivery; missing fabric shows as
 * negative on hand. The same source + externalRef again returns the first sale.
 */
export async function recordSale(
  db: DB,
  actor: string,
  input: { productId: string; qty: number; soldOn: string; source: SaleSource; externalRef?: string | null; note?: string | null },
): Promise<{ sale: Sale; created: boolean }> {
  if (!Number.isInteger(input.qty) || input.qty < 1) throw new UserError("Quantity must be a whole number of 1 or more.");
  const externalRef = input.externalRef?.trim() || null;

  return db.transaction(async (tx) => {
    const [product] = await tx.select().from(products).where(eq(products.id, input.productId));
    if (!product) throw new UserError("Product not found.");
    const [steel, fabric] = await Promise.all([
      tx
        .select({ steelItemId: productSteel.steelItemId, qty: productSteel.qty, kind: steelItems.kind })
        .from(productSteel)
        .innerJoin(steelItems, eq(productSteel.steelItemId, steelItems.id))
        .where(eq(productSteel.productId, product.id)),
      tx.select().from(productComponents).where(eq(productComponents.productId, product.id)),
    ]);
    // A box alone isn't a recipe: selling would take the box but no fabric or steel.
    if (!steel.some((s) => s.kind === "steel") && fabric.length === 0) {
      throw new UserError(`${product.name} has no recipe yet. Set its steel and fabric under Settings → Products.`);
    }

    const [sale] = await tx
      .insert(sales)
      .values({
        productId: product.id,
        qty: input.qty,
        soldOn: input.soldOn,
        source: input.source,
        externalRef,
        note: input.note?.trim() || null,
        createdBy: actor,
      })
      .onConflictDoNothing()
      .returning();
    if (!sale) {
      // Same order from the same channel: already recorded.
      const [existing] = await tx
        .select()
        .from(sales)
        .where(and(eq(sales.source, input.source), eq(sales.externalRef, externalRef as string)));
      return { sale: existing, created: false };
    }

    // Steel: oldest lots first.
    await lockSteelItems(tx, steel.map((s) => s.steelItemId));
    for (const s of steel) {
      await takeSteel(tx, actor, {
        steelItemId: s.steelItemId,
        qty: s.qty * input.qty,
        usedOn: input.soldOn,
        reason: "sale",
        saleId: sale.id,
        allowShort: true,
      });
    }

    // Fabric: oldest in-stock pieces; anything beyond them comes off the adjustment count.
    const sizeIds = [...new Set(fabric.map((f) => f.cutSizeId))].sort();
    if (sizeIds.length) await tx.select({ id: cutSizes.id }).from(cutSizes).where(inArray(cutSizes.id, sizeIds)).for("update");
    for (const f of fabric) {
      const need = f.qty * input.qty;
      const got = await tx
        .select({ id: pieces.id })
        .from(pieces)
        .where(and(eq(pieces.cutSizeId, f.cutSizeId), eq(pieces.status, "in_stock"), isNull(pieces.voidedAt)))
        .orderBy(asc(pieces.cutOn), asc(pieces.createdAt), asc(pieces.id))
        .limit(need)
        .for("update");
      if (got.length) {
        await tx
          .update(pieces)
          .set({ status: "sold", saleId: sale.id })
          .where(inArray(pieces.id, got.map((p) => p.id)));
      }
      if (got.length < need) {
        await tx.insert(inventoryAdjustments).values({
          cutSizeId: f.cutSizeId,
          qty: got.length - need,
          reason: "sale",
          adjustedOn: input.soldOn,
          note: `Sold ${input.qty} × ${product.name}`,
          saleId: sale.id,
          createdBy: actor,
        });
      }
    }

    await refreshSaleCost(tx, sale.id);
    const [saved] = await tx.select().from(sales).where(eq(sales.id, sale.id));
    return { sale: saved, created: true };
  });
}

/** Undo a sale: its poles go back to their lots and its fabric back into stock. */
export async function voidSale(db: DB, actor: string, saleId: string) {
  await db.transaction(async (tx) => {
    const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for("update");
    if (!sale) throw new UserError("Sale not found.");
    if (sale.voidedAt) throw new UserError("That sale was already undone.");

    const usage = await tx
      .select()
      .from(steelUsage)
      .where(and(eq(steelUsage.saleId, saleId), isNull(steelUsage.voidedAt)));
    const itemIds = [...new Set(usage.map((u) => u.steelItemId))];
    await lockSteelItems(tx, itemIds);
    for (const u of usage) {
      if (u.lotId) {
        const [lot] = await tx.select().from(steelLots).where(eq(steelLots.id, u.lotId)).for("update");
        await tx.update(steelLots).set({ qtyRemaining: lot.qtyRemaining + u.qty }).where(eq(steelLots.id, lot.id));
      }
    }
    const at = new Date();
    await tx.update(steelUsage).set({ voidedAt: at }).where(and(eq(steelUsage.saleId, saleId), isNull(steelUsage.voidedAt)));
    await tx.update(pieces).set({ status: "in_stock", saleId: null }).where(eq(pieces.saleId, saleId));
    await tx.delete(inventoryAdjustments).where(eq(inventoryAdjustments.saleId, saleId));
    await tx.update(sales).set({ voidedAt: at, voidedBy: actor }).where(eq(sales.id, saleId));
    // Returned poles can fill other sales that ran short.
    for (const id of itemIds) await settleShortages(tx, id);
  });
}

export async function listSales(db: DB, limit = 30) {
  return db
    .select({ sale: sales, productName: products.name })
    .from(sales)
    .innerJoin(products, eq(sales.productId, products.id))
    .where(isNull(sales.voidedAt))
    .orderBy(desc(sales.soldOn), desc(sales.createdAt))
    .limit(limit);
}
