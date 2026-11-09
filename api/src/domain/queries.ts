import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import {
  cutSessions,
  cutSizes,
  inventoryAdjustments,
  materials,
  pieces,
  productComponents,
  products,
  productSteel,
  rolls,
  sewBatches,
  steelItems,
  summitReceipts,
  summitShipments,
} from "../db/schema";
import type { DB } from "../db/types";
import { UserError } from "./errors";
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
    .select({ size: cutSizes, materialName: materials.name, requiresSewing: cutSizes.requiresSewing })
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
      // Pieces sewn, at Summit or sold: these block undoing the cut.
      movedOn: sql<number>`count(*) filter (where ${pieces.status} = 'sold' or (${pieces.status} <> 'cut' and ${pieces.sewnBy} is distinct from 'not_sewn'))::int`,
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
      requiresSewing: cutSizes.requiresSewing,
      active: cutSizes.active,
      cut: sql<number>`count(${pieces.id}) filter (where ${pieces.status} = 'cut' and ${pieces.voidedAt} is null)::int`,
      atSummit: sql<number>`count(${pieces.id}) filter (where ${pieces.status} = 'at_summit' and ${pieces.voidedAt} is null)::int`,
      inStockPieces: sql<number>`count(${pieces.id}) filter (where ${pieces.status} = 'in_stock' and ${pieces.voidedAt} is null)::int`,
      oldestCut: sql<string | null>`min(${pieces.cutOn}) filter (where ${pieces.status} = 'cut' and ${pieces.voidedAt} is null)`,
    })
    .from(cutSizes)
    .innerJoin(materials, eq(cutSizes.materialId, materials.id))
    .leftJoin(pieces, eq(pieces.cutSizeId, cutSizes.id))
    .groupBy(cutSizes.id, materials.name)
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

  const steel = await db
    .select({
      productId: productSteel.productId,
      steelItemId: productSteel.steelItemId,
      qty: productSteel.qty,
      name: steelItems.name,
      kind: steelItems.kind,
    })
    .from(productSteel)
    .innerJoin(steelItems, eq(productSteel.steelItemId, steelItems.id))
    .orderBy(asc(steelItems.sortOrder), asc(steelItems.name));

  type Part = { steelItemId: string; qty: number; name: string };
  type Entry = {
    product: typeof products.$inferSelect;
    uses: { qty: number; label: string; material: string }[];
    steel: Part[];
    box: Part | null;
  };
  const byId = new Map<string, Entry>();
  for (const r of rows) {
    let entry = byId.get(r.product.id);
    if (!entry) {
      const parts = steel.filter((s) => s.productId === r.product.id);
      const part = (s: (typeof parts)[number]): Part => ({ steelItemId: s.steelItemId, qty: s.qty, name: s.name });
      const box = parts.find((s) => s.kind === "box");
      entry = {
        product: r.product,
        uses: [],
        steel: parts.filter((s) => s.kind === "steel").map(part),
        box: box ? part(box) : null,
      };
      byId.set(r.product.id, entry);
    }
    if (r.sizeLabel && r.materialName && r.qty != null) {
      entry.uses.push({ qty: r.qty, label: r.sizeLabel, material: r.materialName });
    }
  }
  return [...byId.values()];
}

/** A product's own SKU and packed weight. */
export async function updateProductShipping(db: DB, id: string, input: { sku?: string | null; shipWeightLb: number | null }) {
  const sku = input.sku?.trim() || null;
  if (sku) {
    const [clash] = await db.select({ id: products.id, name: products.name }).from(products).where(eq(products.sku, sku));
    if (clash && clash.id !== id) throw new UserError(`SKU ${sku} is already used by ${clash.name}.`);
  }
  await db.update(products).set({ sku, shipWeightLb: input.shipWeightLb }).where(eq(products.id, id));
}
