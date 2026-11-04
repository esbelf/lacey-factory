import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import {
  cutSessions,
  cutSizes,
  inventoryAdjustments,
  materials,
  pieces,
  productComponents,
  products,
  rolls,
  sewBatches,
  summitReceipts,
  summitShipments,
} from "../db/schema";
import type { DB } from "../db/types";
import { subtractFeet } from "@lacey-factory/shared/feet";

export type RollStatus = "uncut" | "partially_cut" | "closed";

export function rollStatus(pieceCount: number, closedOn: string | null): RollStatus {
  if (closedOn) return "closed";
  return pieceCount === 0 ? "uncut" : "partially_cut";
}

const livePiece = isNull(pieces.voidedAt);

export async function listMaterials(db: DB) {
  return db.select().from(materials).orderBy(asc(materials.name));
}

export async function listCutSizes(db: DB) {
  return db
    .select({ size: cutSizes, materialName: materials.name, requiresSewing: materials.requiresSewing })
    .from(cutSizes)
    .innerJoin(materials, eq(cutSizes.materialId, materials.id))
    .orderBy(asc(materials.name), asc(cutSizes.sortOrder), asc(cutSizes.label));
}

export async function listRolls(db: DB) {
  const rows = await db
    .select({
      roll: rolls,
      materialName: materials.name,
      usedFt: sql<number>`coalesce(sum(${pieces.cutLengthFt}) filter (where ${pieces.id} is not null and ${pieces.voidedAt} is null), 0)::float`,
      pieceCount: sql<number>`count(${pieces.id}) filter (where ${pieces.voidedAt} is null)::int`,
    })
    .from(rolls)
    .innerJoin(materials, eq(rolls.materialId, materials.id))
    .leftJoin(pieces, eq(pieces.rollId, rolls.id))
    .groupBy(rolls.id, materials.name)
    .orderBy(desc(rolls.receivedOn), desc(rolls.seq));

  const order: Record<RollStatus, number> = { uncut: 0, partially_cut: 1, closed: 2 };
  return rows
    .map((r) => ({
      ...r,
      status: rollStatus(r.pieceCount, r.roll.closedOn),
      remainingFt: subtractFeet(r.roll.lengthFt, r.usedFt),
    }))
    .sort((a, b) => order[a.status] - order[b.status]);
}

export async function getRoll(db: DB, id: string) {
  const [row] = await db
    .select({ roll: rolls, material: materials })
    .from(rolls)
    .innerJoin(materials, eq(rolls.materialId, materials.id))
    .where(eq(rolls.id, id));
  if (!row) return null;

  const sessions = await db
    .select()
    .from(cutSessions)
    .where(eq(cutSessions.rollId, id))
    .orderBy(desc(cutSessions.cutOn), desc(cutSessions.createdAt));

  const sessionLines = await db
    .select({
      sessionId: pieces.cutSessionId,
      label: cutSizes.label,
      qty: sql<number>`count(*)::int`,
      feet: sql<number>`sum(${pieces.cutLengthFt})::float`,
      stillCut: sql<number>`count(*) filter (where ${pieces.status} = 'cut')::int`,
    })
    .from(pieces)
    .innerJoin(cutSizes, eq(pieces.cutSizeId, cutSizes.id))
    .where(eq(pieces.rollId, id))
    .groupBy(pieces.cutSessionId, cutSizes.label, cutSizes.sortOrder)
    .orderBy(asc(cutSizes.sortOrder));

  const totals = await db
    .select({
      label: cutSizes.label,
      qty: sql<number>`count(*)::int`,
      feet: sql<number>`sum(${pieces.cutLengthFt})::float`,
    })
    .from(pieces)
    .innerJoin(cutSizes, eq(pieces.cutSizeId, cutSizes.id))
    .where(and(eq(pieces.rollId, id), livePiece))
    .groupBy(cutSizes.label, cutSizes.sortOrder)
    .orderBy(asc(cutSizes.sortOrder));

  const sizes = await db
    .select()
    .from(cutSizes)
    .where(and(eq(cutSizes.materialId, row.roll.materialId), eq(cutSizes.active, true)))
    .orderBy(asc(cutSizes.sortOrder), asc(cutSizes.label));

  const usedFt = totals.reduce((acc, t) => acc + Math.round(t.feet * 100), 0) / 100;
  const pieceCount = totals.reduce((acc, t) => acc + t.qty, 0);

  return {
    ...row,
    sessions: sessions.map((s) => ({
      ...s,
      lines: sessionLines.filter((l) => l.sessionId === s.id),
    })),
    totals,
    sizes,
    usedFt,
    remainingFt: subtractFeet(row.roll.lengthFt, usedFt),
    status: rollStatus(pieceCount, row.roll.closedOn),
  };
}

/** Pieces by material + size and stage — drives /cut, /summit and /inventory. */
export async function pipelineBySize(db: DB) {
  const counts = await db
    .select({
      cutSizeId: cutSizes.id,
      label: cutSizes.label,
      productFamily: cutSizes.productFamily,
      materialName: materials.name,
      requiresSewing: materials.requiresSewing,
      active: cutSizes.active,
      cut: sql<number>`count(${pieces.id}) filter (where ${pieces.status} = 'cut' and ${pieces.voidedAt} is null)::int`,
      atSummit: sql<number>`count(${pieces.id}) filter (where ${pieces.status} = 'at_summit' and ${pieces.voidedAt} is null)::int`,
      inStockPieces: sql<number>`count(${pieces.id}) filter (where ${pieces.status} = 'in_stock' and ${pieces.voidedAt} is null)::int`,
      oldestCut: sql<string | null>`min(${pieces.cutOn}) filter (where ${pieces.status} = 'cut' and ${pieces.voidedAt} is null)`,
    })
    .from(cutSizes)
    .innerJoin(materials, eq(cutSizes.materialId, materials.id))
    .leftJoin(pieces, eq(pieces.cutSizeId, cutSizes.id))
    .groupBy(cutSizes.id, materials.name, materials.requiresSewing)
    .orderBy(asc(materials.name), asc(cutSizes.sortOrder), asc(cutSizes.label));

  const adj = await db
    .select({
      cutSizeId: inventoryAdjustments.cutSizeId,
      n: sql<number>`sum(${inventoryAdjustments.qty})::int`,
    })
    .from(inventoryAdjustments)
    .groupBy(inventoryAdjustments.cutSizeId);
  const adjBySize = new Map(adj.map((a) => [a.cutSizeId, a.n]));

  const oldestAtSummit = await db
    .select({ cutSizeId: pieces.cutSizeId, sentOn: sql<string>`min(${summitShipments.sentOn})` })
    .from(pieces)
    .innerJoin(summitShipments, eq(pieces.summitShipmentId, summitShipments.id))
    .where(and(eq(pieces.status, "at_summit"), livePiece))
    .groupBy(pieces.cutSizeId);
  const sentBySize = new Map(oldestAtSummit.map((o) => [o.cutSizeId, o.sentOn]));

  return counts.map((c) => {
    const adjustments = adjBySize.get(c.cutSizeId) ?? 0;
    return {
      ...c,
      adjustments,
      onHand: c.inStockPieces + adjustments,
      oldestSentToSummit: sentBySize.get(c.cutSizeId) ?? null,
    };
  });
}

/** Recent sewing / Summit entries, so a mistake can be undone. */
export async function recentActivity(db: DB, limit = 15) {
  const summarize = (col: typeof pieces.sewBatchId | typeof pieces.summitShipmentId) =>
    db
      .select({
        batchId: col,
        label: sql<string>`${materials.name} || ' ' || ${cutSizes.label}`,
        qty: sql<number>`count(*)::int`,
      })
      .from(pieces)
      .innerJoin(cutSizes, eq(pieces.cutSizeId, cutSizes.id))
      .innerJoin(materials, eq(cutSizes.materialId, materials.id))
      .where(sql`${col} is not null`)
      .groupBy(col, materials.name, cutSizes.label);

  const [sews, shipments, receipts, sewLines, shipLines] = await Promise.all([
    db.select().from(sewBatches).where(isNull(sewBatches.voidedAt)).orderBy(desc(sewBatches.createdAt)).limit(limit),
    db
      .select()
      .from(summitShipments)
      .where(isNull(summitShipments.voidedAt))
      .orderBy(desc(summitShipments.createdAt))
      .limit(limit),
    db
      .select({ receipt: summitReceipts, label: cutSizes.label, materialName: materials.name })
      .from(summitReceipts)
      .innerJoin(cutSizes, eq(summitReceipts.cutSizeId, cutSizes.id))
      .innerJoin(materials, eq(cutSizes.materialId, materials.id))
      .where(isNull(summitReceipts.voidedAt))
      .orderBy(desc(summitReceipts.createdAt))
      .limit(limit),
    summarize(pieces.sewBatchId),
    summarize(pieces.summitShipmentId),
  ]);

  return {
    sews: sews.map((s) => ({ ...s, lines: sewLines.filter((l) => l.batchId === s.id) })),
    shipments: shipments.map((s) => ({ ...s, lines: shipLines.filter((l) => l.batchId === s.id) })),
    receipts,
  };
}

export async function recentAdjustments(db: DB, limit = 25) {
  return db
    .select({ adj: inventoryAdjustments, label: cutSizes.label, materialName: materials.name })
    .from(inventoryAdjustments)
    .innerJoin(cutSizes, eq(inventoryAdjustments.cutSizeId, cutSizes.id))
    .innerJoin(materials, eq(cutSizes.materialId, materials.id))
    .orderBy(desc(inventoryAdjustments.createdAt))
    .limit(limit);
}

/** Products with the pieces each one uses, e.g. Boatlift Mat Extreme → 2 × HPG-57 6x14. */
export async function listProducts(db: DB) {
  const rows = await db
    .select({
      product: products,
      qty: productComponents.qty,
      sizeLabel: cutSizes.label,
      materialName: materials.name,
    })
    .from(products)
    .leftJoin(productComponents, eq(productComponents.productId, products.id))
    .leftJoin(cutSizes, eq(productComponents.cutSizeId, cutSizes.id))
    .leftJoin(materials, eq(cutSizes.materialId, materials.id))
    .orderBy(asc(products.sortOrder), asc(products.name), asc(materials.name));

  const byId = new Map<string, { product: typeof products.$inferSelect; uses: { qty: number; label: string; material: string }[] }>();
  for (const r of rows) {
    const entry = byId.get(r.product.id) ?? { product: r.product, uses: [] };
    if (r.sizeLabel && r.materialName && r.qty != null) {
      entry.uses.push({ qty: r.qty, label: r.sizeLabel, material: r.materialName });
    }
    byId.set(r.product.id, entry);
  }
  return [...byId.values()];
}
