// All writes for the production flow. Every function takes the database and
// the email of the person doing it, and runs in one transaction with row locks
// so two people working at once can't double-cut a roll or double-sew a piece.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  cutSessions,
  cutSizes,
  inventoryAdjustments,
  materials,
  pieces,
  rolls,
  sewBatches,
  summitReceipts,
  summitShipments,
} from "../db/schema";
import type { DB, Tx } from "../db/types";
import { formatFeet, subtractFeet, sumFeet } from "@lacey-factory/shared/feet";

import { UserError } from "./errors";

export type Line = { cutSizeId: string; qty: number };

function assertLines(lines: Line[]) {
  if (lines.length === 0) throw new UserError("Add at least one size.");
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1) {
      throw new UserError("Quantities must be whole numbers of 1 or more.");
    }
  }
  const ids = lines.map((l) => l.cutSizeId);
  if (new Set(ids).size !== ids.length) {
    throw new UserError("Each size can only appear once per submission.");
  }
}

const now = () => new Date();

// ───────────────────────── Settings ─────────────────────────

export async function createMaterial(
  db: DB,
  input: { name: string; requiresSewing: boolean; defaultWidthFt?: number | null },
) {
  const name = input.name.trim();
  if (!name) throw new UserError("Material name is required.");
  const existing = await db.select().from(materials).where(eq(materials.name, name));
  if (existing.length) throw new UserError(`A material named "${name}" already exists.`);
  const [row] = await db
    .insert(materials)
    .values({ name, requiresSewing: input.requiresSewing, defaultWidthFt: input.defaultWidthFt ?? null })
    .returning();
  return row;
}

export async function setMaterialActive(db: DB, id: string, active: boolean) {
  await db.update(materials).set({ active }).where(eq(materials.id, id));
}

export async function createCutSize(
  db: DB,
  input: {
    materialId: string;
    label: string;
    widthFt: number;
    cutLengthFt: number;
    productFamily?: string | null;
    sortOrder?: number;
  },
) {
  const label = input.label.trim();
  if (!label) throw new UserError("Size label is required (e.g. 12x24).");
  if (!(input.widthFt > 0) || !(input.cutLengthFt > 0)) {
    throw new UserError("Width and cut length must be greater than 0.");
  }
  const dup = await db
    .select({ id: cutSizes.id })
    .from(cutSizes)
    .where(and(eq(cutSizes.materialId, input.materialId), eq(cutSizes.label, label)));
  if (dup.length) throw new UserError(`Size "${label}" already exists for this material.`);
  const [row] = await db
    .insert(cutSizes)
    .values({
      materialId: input.materialId,
      label,
      widthFt: input.widthFt,
      cutLengthFt: input.cutLengthFt,
      productFamily: input.productFamily?.trim() || null,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  return row;
}

/** Changing the cut length only affects future cuts; past pieces keep theirs. */
export async function updateCutSize(
  db: DB,
  id: string,
  input: { cutLengthFt?: number; productFamily?: string | null; sortOrder?: number; active?: boolean },
) {
  if (input.cutLengthFt !== undefined && !(input.cutLengthFt > 0)) {
    throw new UserError("Cut length must be greater than 0.");
  }
  await db.update(cutSizes).set(input).where(eq(cutSizes.id, id));
}

// ───────────────────────── Rolls & cutting ─────────────────────────

export async function createRoll(
  db: DB,
  actor: string,
  input: {
    materialId: string;
    supplierRollNo?: string | null;
    supplier?: string | null;
    widthFt: number;
    lengthFt: number;
    receivedOn: string;
    notes?: string | null;
  },
) {
  if (!(input.widthFt > 0) || !(input.lengthFt > 0)) {
    throw new UserError("Width and length must be greater than 0.");
  }
  const [mat] = await db.select().from(materials).where(eq(materials.id, input.materialId));
  if (!mat) throw new UserError("Pick a material.");
  const [row] = await db
    .insert(rolls)
    .values({
      materialId: input.materialId,
      supplierRollNo: input.supplierRollNo?.trim() || null,
      supplier: input.supplier?.trim() || null,
      widthFt: input.widthFt,
      lengthFt: input.lengthFt,
      receivedOn: input.receivedOn,
      notes: input.notes?.trim() || null,
      createdBy: actor,
    })
    .returning();
  return row;
}

async function usedFeet(tx: Tx, rollId: string): Promise<number> {
  const rows = await tx
    .select({ len: pieces.cutLengthFt })
    .from(pieces)
    .where(and(eq(pieces.rollId, rollId), isNull(pieces.voidedAt)));
  return sumFeet(rows.map((r) => r.len));
}

export async function recordCut(
  db: DB,
  actor: string,
  input: { rollId: string; cutOn: string; lines: Line[]; notes?: string | null },
) {
  assertLines(input.lines);
  return db.transaction(async (tx) => {
    // Lock the roll so two cut submissions can't both use the same remaining feet.
    const [roll] = await tx.select().from(rolls).where(eq(rolls.id, input.rollId)).for("update");
    if (!roll) throw new UserError("Roll not found.");
    if (roll.closedOn) throw new UserError(`${roll.appCode} is closed out. Reopen it to cut more.`);
    if (input.cutOn < roll.receivedOn) {
      throw new UserError(`Cut date can't be before the roll was received (${roll.receivedOn}).`);
    }

    const [mat] = await tx.select().from(materials).where(eq(materials.id, roll.materialId));
    const sizes = await tx
      .select()
      .from(cutSizes)
      .where(inArray(cutSizes.id, input.lines.map((l) => l.cutSizeId)));
    const sizeById = new Map(sizes.map((s) => [s.id, s]));
    for (const l of input.lines) {
      const s = sizeById.get(l.cutSizeId);
      if (!s || s.materialId !== roll.materialId) {
        throw new UserError("One of the sizes doesn't belong to this roll's material.");
      }
      if (!s.active) throw new UserError(`Size ${s.label} is turned off in settings.`);
    }

    const remaining = subtractFeet(roll.lengthFt, await usedFeet(tx, roll.id));
    const needed = sumFeet(input.lines.map((l) => sizeById.get(l.cutSizeId)!.cutLengthFt * l.qty));
    if (needed > remaining) {
      throw new UserError(
        `That needs ${formatFeet(needed)} but only ${formatFeet(remaining)} is left on ${roll.appCode}.`,
      );
    }

    const [session] = await tx
      .insert(cutSessions)
      .values({ rollId: roll.id, cutOn: input.cutOn, notes: input.notes?.trim() || null, createdBy: actor })
      .returning();

    // Materials that aren't sewn (geogrid) go straight to inventory.
    const sewn = mat.requiresSewing;
    const rows = input.lines.flatMap((l) =>
      Array.from({ length: l.qty }, () => ({
        cutSessionId: session.id,
        rollId: roll.id,
        cutSizeId: l.cutSizeId,
        cutLengthFt: sizeById.get(l.cutSizeId)!.cutLengthFt,
        cutOn: input.cutOn,
        status: sewn ? ("cut" as const) : ("in_stock" as const),
        sewnBy: sewn ? null : ("not_sewn" as const),
      })),
    );
    await tx.insert(pieces).values(rows);
    return { session, remainingAfter: subtractFeet(remaining, needed) };
  });
}

/** Undo a cut. Only allowed while none of its pieces have been sewn or sent out. */
export async function voidCutSession(db: DB, actor: string, sessionId: string) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(cutSessions)
      .where(eq(cutSessions.id, sessionId))
      .for("update");
    if (!session) throw new UserError("Cut not found.");
    if (session.voidedAt) throw new UserError("That cut was already undone.");
    const ps = await tx
      .select()
      .from(pieces)
      .where(and(eq(pieces.cutSessionId, sessionId), isNull(pieces.voidedAt)))
      .for("update");
    const moved = ps.some((p) => p.status !== "cut" && p.sewnBy !== "not_sewn");
    if (moved) {
      throw new UserError("Some of these pieces were already sewn or sent to Summit. Undo that first.");
    }
    const at = now();
    await tx.update(cutSessions).set({ voidedAt: at, voidedBy: actor }).where(eq(cutSessions.id, sessionId));
    await tx.update(pieces).set({ voidedAt: at }).where(eq(pieces.cutSessionId, sessionId));
  });
}

export async function closeRoll(
  db: DB,
  input: { rollId: string; closedOn: string; leftoverFtMeasured: number | null },
) {
  if (input.leftoverFtMeasured != null && input.leftoverFtMeasured < 0) {
    throw new UserError("Leftover can't be negative.");
  }
  await db
    .update(rolls)
    .set({ closedOn: input.closedOn, leftoverFtMeasured: input.leftoverFtMeasured })
    .where(eq(rolls.id, input.rollId));
}

export async function reopenRoll(db: DB, rollId: string) {
  await db.update(rolls).set({ closedOn: null, leftoverFtMeasured: null }).where(eq(rolls.id, rollId));
}

// ───────────────────────── Sewing & Summit ─────────────────────────

/** Lock the oldest `qty` pieces of a size with the given status (FIFO). */
async function takeOldest(
  tx: Tx,
  cutSizeId: string,
  qty: number,
  status: "cut" | "at_summit",
): Promise<(typeof pieces.$inferSelect)[]> {
  const base = tx
    .select({ piece: pieces })
    .from(pieces)
    .where(and(eq(pieces.cutSizeId, cutSizeId), eq(pieces.status, status), isNull(pieces.voidedAt)));
  const rows =
    status === "at_summit"
      ? await base
          .innerJoin(summitShipments, eq(pieces.summitShipmentId, summitShipments.id))
          .orderBy(asc(summitShipments.sentOn), asc(pieces.cutOn), asc(pieces.createdAt), asc(pieces.id))
          .limit(qty)
          .for("update", { of: pieces })
      : await base
          .orderBy(asc(pieces.cutOn), asc(pieces.createdAt), asc(pieces.id))
          .limit(qty)
          .for("update", { of: pieces });
  return rows.map((r) => r.piece);
}

async function sizeLabel(tx: Tx, cutSizeId: string) {
  const [s] = await tx
    .select({ label: cutSizes.label, material: materials.name, requiresSewing: materials.requiresSewing })
    .from(cutSizes)
    .innerJoin(materials, eq(cutSizes.materialId, materials.id))
    .where(eq(cutSizes.id, cutSizeId));
  if (!s) throw new UserError("Size not found.");
  return s;
}

async function takeForLines(tx: Tx, lines: Line[], status: "cut" | "at_summit", actionDate: string) {
  const taken: (typeof pieces.$inferSelect)[] = [];
  for (const l of lines) {
    const s = await sizeLabel(tx, l.cutSizeId);
    if (!s.requiresSewing) throw new UserError(`${s.material} isn't sewn.`);
    const got = await takeOldest(tx, l.cutSizeId, l.qty, status);
    if (got.length < l.qty) {
      const where = status === "cut" ? "waiting to be sewn" : "at Summit";
      throw new UserError(`Only ${got.length} × ${s.material} ${s.label} ${where}, not ${l.qty}.`);
    }
    const newestCut = got.reduce((m, p) => (p.cutOn > m ? p.cutOn : m), "");
    if (actionDate < newestCut) {
      throw new UserError(`Date can't be before these pieces were cut (${newestCut}).`);
    }
    taken.push(...got);
  }
  return taken;
}

export async function markSewnInHouse(db: DB, actor: string, input: { sewnOn: string; lines: Line[] }) {
  assertLines(input.lines);
  return db.transaction(async (tx) => {
    const taken = await takeForLines(tx, input.lines, "cut", input.sewnOn);
    const [batch] = await tx.insert(sewBatches).values({ sewnOn: input.sewnOn, createdBy: actor }).returning();
    await tx
      .update(pieces)
      .set({ status: "in_stock", sewnBy: "in_house", sewnOn: input.sewnOn, sewBatchId: batch.id })
      .where(inArray(pieces.id, taken.map((p) => p.id)));
    return batch;
  });
}

export async function voidSewBatch(db: DB, actor: string, batchId: string) {
  await db.transaction(async (tx) => {
    const [batch] = await tx.select().from(sewBatches).where(eq(sewBatches.id, batchId)).for("update");
    if (!batch || batch.voidedAt) throw new UserError("That sewing entry was already undone.");
    await tx.update(sewBatches).set({ voidedAt: now(), voidedBy: actor }).where(eq(sewBatches.id, batchId));
    await tx
      .update(pieces)
      .set({ status: "cut", sewnBy: null, sewnOn: null, sewBatchId: null })
      .where(eq(pieces.sewBatchId, batchId));
  });
}

export async function sendToSummit(
  db: DB,
  actor: string,
  input: { sentOn: string; lines: Line[]; notes?: string | null },
) {
  assertLines(input.lines);
  return db.transaction(async (tx) => {
    const taken = await takeForLines(tx, input.lines, "cut", input.sentOn);
    const [shipment] = await tx
      .insert(summitShipments)
      .values({ sentOn: input.sentOn, notes: input.notes?.trim() || null, createdBy: actor })
      .returning();
    await tx
      .update(pieces)
      .set({ status: "at_summit", summitShipmentId: shipment.id })
      .where(inArray(pieces.id, taken.map((p) => p.id)));
    return shipment;
  });
}

export async function voidSummitShipment(db: DB, actor: string, shipmentId: string) {
  await db.transaction(async (tx) => {
    const [shipment] = await tx
      .select()
      .from(summitShipments)
      .where(eq(summitShipments.id, shipmentId))
      .for("update");
    if (!shipment || shipment.voidedAt) throw new UserError("That shipment was already undone.");
    const received = await tx
      .select({ id: pieces.id })
      .from(pieces)
      .where(and(eq(pieces.summitShipmentId, shipmentId), sql`${pieces.summitReceiptId} is not null`));
    if (received.length) {
      throw new UserError("Some pieces from this shipment were already received. Undo those receipts first.");
    }
    await tx
      .update(summitShipments)
      .set({ voidedAt: now(), voidedBy: actor })
      .where(eq(summitShipments.id, shipmentId));
    await tx
      .update(pieces)
      .set({ status: "cut", summitShipmentId: null })
      .where(eq(pieces.summitShipmentId, shipmentId));
  });
}

/** "We received 25 × 12x24 from Summit" → the 25 oldest sent pieces go to stock. */
export async function receiveFromSummit(
  db: DB,
  actor: string,
  input: { cutSizeId: string; qty: number; receivedOn: string; notes?: string | null },
) {
  assertLines([{ cutSizeId: input.cutSizeId, qty: input.qty }]);
  return db.transaction(async (tx) => {
    const taken = await takeForLines(tx, [input], "at_summit", input.receivedOn);
    const [receipt] = await tx
      .insert(summitReceipts)
      .values({
        cutSizeId: input.cutSizeId,
        qty: input.qty,
        receivedOn: input.receivedOn,
        notes: input.notes?.trim() || null,
        createdBy: actor,
      })
      .returning();
    await tx
      .update(pieces)
      .set({ status: "in_stock", sewnBy: "summit", sewnOn: input.receivedOn, summitReceiptId: receipt.id })
      .where(inArray(pieces.id, taken.map((p) => p.id)));
    return receipt;
  });
}

export async function voidSummitReceipt(db: DB, actor: string, receiptId: string) {
  await db.transaction(async (tx) => {
    const [receipt] = await tx
      .select()
      .from(summitReceipts)
      .where(eq(summitReceipts.id, receiptId))
      .for("update");
    if (!receipt || receipt.voidedAt) throw new UserError("That receipt was already undone.");
    await tx
      .update(summitReceipts)
      .set({ voidedAt: now(), voidedBy: actor })
      .where(eq(summitReceipts.id, receiptId));
    await tx
      .update(pieces)
      .set({ status: "at_summit", sewnBy: null, sewnOn: null, summitReceiptId: null })
      .where(eq(pieces.summitReceiptId, receiptId));
  });
}

// ───────────────────────── Inventory ─────────────────────────

export async function onHand(tx: Tx | DB, cutSizeId: string): Promise<number> {
  const [p] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(pieces)
    .where(and(eq(pieces.cutSizeId, cutSizeId), eq(pieces.status, "in_stock"), isNull(pieces.voidedAt)));
  const [a] = await tx
    .select({ n: sql<number>`coalesce(sum(${inventoryAdjustments.qty}), 0)::int` })
    .from(inventoryAdjustments)
    .where(eq(inventoryAdjustments.cutSizeId, cutSizeId));
  return p.n + a.n;
}

export async function adjustInventory(
  db: DB,
  actor: string,
  input: {
    cutSizeId: string;
    qty: number;
    reason: "opening_balance" | "count_correction" | "sale" | "other";
    adjustedOn: string;
    note?: string | null;
  },
) {
  if (!Number.isInteger(input.qty) || input.qty === 0) {
    throw new UserError("Adjustment must be a whole number other than 0.");
  }
  return db.transaction(async (tx) => {
    // Lock the size row so concurrent adjustments see each other.
    await tx.select({ id: cutSizes.id }).from(cutSizes).where(eq(cutSizes.id, input.cutSizeId)).for("update");
    const current = await onHand(tx, input.cutSizeId);
    if (current + input.qty < 0) {
      throw new UserError(`Only ${current} on hand — can't remove ${-input.qty}.`);
    }
    const [row] = await tx
      .insert(inventoryAdjustments)
      .values({ ...input, note: input.note?.trim() || null, createdBy: actor })
      .returning();
    return row;
  });
}
