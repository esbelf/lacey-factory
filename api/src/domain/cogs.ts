// Fabric and sewing cost of goods sold. Steel and boxes are costed in steel.ts.
//
// Fabric: a piece costs its cut length × its roll's price per foot (roll cost ÷
// roll length), so any unused width counts as scrap of that piece. Sales take
// the oldest pieces first, so this is FIFO. Pieces a sale needed but that
// weren't in stock are estimated from the newest priced roll of that material.
//
// Sewing: each product has a per-product rate for in-house and for Summit.
// A sale is charged by how its pieces were actually sewn, at the rates in
// place when it sold.
import { fromUnits, sumMoney, toUnits } from "@lacey-factory/shared/money";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";

import { cutSizes, inventoryAdjustments, pieces, rolls, sales } from "../db/schema";
import type { DB, Tx } from "../db/types";
import { UserError } from "./errors";

/** cutLengthFt × roll cost ÷ roll length, to the ten-thousandth; null when the roll has no price. */
export function pieceCost(cutLengthFt: number, roll: { cost: number | null; lengthFt: number }): number | null {
  if (roll.cost == null || !(roll.lengthFt > 0)) return null;
  return fromUnits(Math.round((toUnits(roll.cost) * cutLengthFt) / roll.lengthFt));
}

/**
 * Sewing cost of `qty` products. `sewn` counts the sale's pieces by who sewed
 * them; a product made only from unsewn sizes costs nothing to sew. Pieces
 * that weren't in stock are assumed sewn in-house.
 */
export function sewingCost(
  qty: number,
  sewsPieces: boolean,
  sewn: { inHouse: number; summit: number },
  rates: { inHouse: number | null; summit: number | null },
): { cost: number; missing: boolean } {
  if (!sewsPieces) return { cost: 0, missing: false };
  const total = sewn.inHouse + sewn.summit;
  const summitShare = total > 0 ? sewn.summit / total : 0;
  let missing = false;
  let perUnitUnits = 0;
  if (summitShare > 0) {
    if (rates.summit == null) missing = true;
    else perUnitUnits += summitShare * toUnits(rates.summit);
  }
  if (summitShare < 1) {
    if (rates.inHouse == null) missing = true;
    else perUnitUnits += (1 - summitShare) * toUnits(rates.inHouse);
  }
  return { cost: fromUnits(Math.round(qty * perUnitUnits)), missing };
}

/** Recomputes a sale's fabric cost from the pieces it took (and estimates for any it was short). */
export async function refreshFabricCost(tx: Tx, saleId: string) {
  const sold = await tx
    .select({ cutLengthFt: pieces.cutLengthFt, cost: rolls.cost, lengthFt: rolls.lengthFt })
    .from(pieces)
    .innerJoin(rolls, eq(pieces.rollId, rolls.id))
    .where(eq(pieces.saleId, saleId));
  const short = await tx
    .select({ qty: inventoryAdjustments.qty, cutLengthFt: cutSizes.cutLengthFt, materialId: cutSizes.materialId })
    .from(inventoryAdjustments)
    .innerJoin(cutSizes, eq(inventoryAdjustments.cutSizeId, cutSizes.id))
    .where(and(eq(inventoryAdjustments.saleId, saleId), lt(inventoryAdjustments.qty, 0)));

  let missing = false;
  const costs: number[] = [];
  for (const p of sold) {
    const c = pieceCost(p.cutLengthFt, p);
    if (c == null) missing = true;
    else costs.push(c);
  }
  for (const s of short) {
    const [roll] = await tx
      .select({ cost: rolls.cost, lengthFt: rolls.lengthFt })
      .from(rolls)
      .where(and(eq(rolls.materialId, s.materialId), isNotNull(rolls.cost)))
      .orderBy(desc(rolls.receivedOn), desc(rolls.createdAt))
      .limit(1);
    const c = roll ? pieceCost(s.cutLengthFt, roll) : null;
    if (c == null) missing = true;
    else costs.push(fromUnits(toUnits(c) * -s.qty));
  }
  await tx.update(sales).set({ fabricCost: sumMoney(costs), fabricCostMissing: missing }).where(eq(sales.id, saleId));
}

/**
 * Sets a roll's price and re-costs the sales that used it, plus sales still
 * waiting for a price (their estimate may come from this roll).
 */
export async function setRollCost(db: DB, rollId: string, cost: number | null) {
  if (cost != null && !(cost >= 0)) throw new UserError("The price can't be negative.");
  await db.transaction(async (tx) => {
    const [roll] = await tx.update(rolls).set({ cost }).where(eq(rolls.id, rollId)).returning({ id: rolls.id });
    if (!roll) throw new UserError("Roll not found.");
    await refreshSalesForRolls(tx, [rollId]);
  });
}

export async function refreshSalesForRolls(tx: Tx, rollIds: string[]) {
  if (!rollIds.length) return;
  const touched = await tx
    .selectDistinct({ id: sales.id })
    .from(sales)
    .leftJoin(pieces, eq(pieces.saleId, sales.id))
    .where(and(isNull(sales.voidedAt), or(inArray(pieces.rollId, rollIds), eq(sales.fabricCostMissing, true))));
  for (const s of touched) await refreshFabricCost(tx, s.id);
}
