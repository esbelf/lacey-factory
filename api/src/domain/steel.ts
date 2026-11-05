// Steel poles: invoice lines → FIFO cost lots, and taking poles out (sales,
// count corrections). Matching is pure (planSteel, allocateFreight); writes run
// in one transaction with the steel item row locked.
import { fromUnits, mulMoney, sumMoney, toUnits } from "@lacey-factory/shared/money";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { productSteel, sales, steelItems, steelLots, steelUsage, supplierSteelProducts } from "../db/schema";
import type { DB, Tx } from "../db/types";
import type { DocumentExtraction } from "../temporal/extract";
import { UserError } from "./errors";
import { codeMatches, lockDocument, markRegistered, readyForAuto, receivedOnFor, setDocumentStatus } from "./invoices";

export type SteelMapping = typeof supplierSteelProducts.$inferSelect;
export type PlannedSteelLine = { steelItemId: string; label: string; qty: number; unitCost: number; amount: number };
export type SteelPlan = { ok: true; lines: PlannedSteelLine[]; freight: number } | { ok: false; reason: string };

type ExtractedLine = DocumentExtraction["lines"][number];

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const money = (n: number) => `$${n.toFixed(2)}`;
/** Units that mean "per pole". Anything else (LB, FT, CWT) can't be counted as poles. */
const PIECE_UOM = /^(ea|each|pc|pcs|piece|pieces|pole|poles|jt|jts|joint|joints|stick|sticks|length|lengths)$/i;

/** Older readings have no line_kind, so guess from the description. */
function kindOf(line: ExtractedLine) {
  return line.line_kind ?? (/freight|shipping|delivery|handling/i.test(line.description) ? "freight" : "product");
}

function lineAmount(line: ExtractedLine): number | null {
  if (line.amount != null) return line.amount;
  if (line.quantity != null && line.unit_price != null) return mulMoney(line.quantity, line.unit_price);
  return null;
}

function findMapping(line: ExtractedLine, mappings: SteelMapping[]) {
  if (line.product_code) {
    const byCode = mappings.filter((m) => codeMatches(line.product_code, m.productCode));
    if (byCode.length === 1) return { mapping: byCode[0] };
    if (byCode.length > 1) return { ambiguous: true as const };
  }
  const desc = norm(line.description);
  const byDesc = mappings.filter((m) => m.descriptionMatch && desc.includes(norm(m.descriptionMatch)));
  if (byDesc.length === 1) return { mapping: byDesc[0] };
  if (byDesc.length > 1) return { ambiguous: true as const };
  return {};
}

/**
 * Turns a steel invoice into lots to receive, or explains why a person needs
 * to look at it. Every product line must map to a steel item, be counted by
 * the piece and have a rate that matches its amount; freight lines add up to
 * the shipping cost; and the lines must add up to the invoice total.
 */
export function planSteel(doc: DocumentExtraction, mappings: SteelMapping[]): SteelPlan {
  if (!doc.is_invoice_or_packing_list) return { ok: false, reason: "Not an invoice." };
  const out: PlannedSteelLine[] = [];
  const freightAmounts: number[] = [];
  const otherAmounts: number[] = [];

  for (const line of doc.lines) {
    const label = line.product_code ? `${line.product_code} ${line.description}` : line.description;
    const kind = kindOf(line);
    if (kind === "freight") {
      const amount = lineAmount(line);
      if (amount == null) return { ok: false, reason: `The freight line "${label}" has no amount.` };
      freightAmounts.push(amount);
      continue;
    }
    if (kind !== "product") {
      const amount = lineAmount(line);
      if (amount != null) otherAmounts.push(amount);
      continue;
    }

    const found = findMapping(line, mappings);
    if ("ambiguous" in found) return { ok: false, reason: `"${label}" matches more than one steel item.` };
    if (!found.mapping) return { ok: false, reason: `Unknown steel item "${label}". Add it under Settings → Suppliers.` };
    if (line.uom && !PIECE_UOM.test(line.uom.trim())) {
      return { ok: false, reason: `"${label}" is priced per ${line.uom}, not per pole.` };
    }
    const qty = line.quantity;
    if (qty == null || !Number.isInteger(qty) || qty < 1) {
      return { ok: false, reason: `Can't tell how many poles "${label}" is (quantity ${qty ?? "?"}).` };
    }
    if (line.unit_price == null && line.amount == null) return { ok: false, reason: `"${label}" has no rate or amount.` };
    const unitCost = line.unit_price ?? fromUnits(Math.round(toUnits(line.amount as number) / qty));
    const amount = line.amount ?? mulMoney(qty, unitCost);
    // Rates are often rounded on the invoice, so allow a cent per pole.
    if (Math.abs(toUnits(mulMoney(qty, unitCost)) - toUnits(amount)) > Math.max(100, 100 * qty)) {
      return {
        ok: false,
        reason: `"${label}": ${qty} × ${money(unitCost)} = ${money(mulMoney(qty, unitCost))}, but the line says ${money(amount)}.`,
      };
    }
    out.push({ steelItemId: found.mapping.steelItemId, label, qty, unitCost, amount });
  }

  if (out.length === 0) return { ok: false, reason: "No steel lines found." };
  const freight = sumMoney(freightAmounts);
  if (doc.invoice_total != null) {
    const sum = sumMoney([...out.map((l) => l.amount), freight, ...otherAmounts]);
    if (Math.abs(toUnits(sum) - toUnits(doc.invoice_total)) > 500) {
      return {
        ok: false,
        reason: `The lines add up to ${money(sum)} but the invoice total is ${money(doc.invoice_total)}. A line may have been missed.`,
      };
    }
  }
  return { ok: true, lines: out, freight };
}

/**
 * Splits freight over lines by their dollar value (by quantity if they're all
 * $0). Works in ten-thousandths; the rounding remainder goes to the biggest
 * line, so the shares always add up to the freight exactly.
 */
export function allocateFreight(lines: { amount: number; qty: number }[], freight: number): number[] {
  const total = toUnits(freight);
  if (lines.length === 0 || total === 0) return lines.map(() => 0);
  let weights = lines.map((l) => toUnits(l.amount));
  if (weights.every((w) => w <= 0)) weights = lines.map((l) => l.qty);
  const sumW = weights.reduce((a, w) => a + w, 0);
  const shares = weights.map((w) => Math.floor((total * w) / sumW));
  const biggest = weights.indexOf(Math.max(...weights));
  shares[biggest] += total - shares.reduce((a, s) => a + s, 0);
  return shares.map(fromUnits);
}

/** Per-pole cost for each planned line: invoice rate plus its share of freight. */
export function landedCosts(lines: PlannedSteelLine[], freight: number) {
  const shares = allocateFreight(lines, freight);
  return lines.map((l, i) => {
    const freightPerUnit = fromUnits(Math.round(toUnits(shares[i]) / l.qty));
    return { ...l, freight: shares[i], freightPerUnit, landedUnitCost: fromUnits(toUnits(l.unitCost) + toUnits(freightPerUnit)) };
  });
}

// ── Stock movements (run inside a transaction) ──

async function lockItems(tx: Tx, ids: string[]) {
  const unique = [...new Set(ids)].sort(); // fixed order, so two sales can't deadlock
  if (unique.length === 0) return [];
  const rows = await tx.select().from(steelItems).where(inArray(steelItems.id, unique)).orderBy(asc(steelItems.id)).for("update");
  if (rows.length !== unique.length) throw new UserError("Steel item not found.");
  return rows;
}

async function openLots(tx: Tx, steelItemId: string) {
  return tx
    .select()
    .from(steelLots)
    .where(and(eq(steelLots.steelItemId, steelItemId), gt(steelLots.qtyRemaining, 0)))
    .orderBy(asc(steelLots.receivedOn), asc(steelLots.createdAt), asc(steelLots.id))
    .for("update");
}

/** Recomputes a sale's steel cost and short flag from its usage rows. */
async function refreshSaleCost(tx: Tx, saleId: string) {
  const rows = await tx
    .select()
    .from(steelUsage)
    .where(and(eq(steelUsage.saleId, saleId), isNull(steelUsage.voidedAt)));
  await tx
    .update(sales)
    .set({
      steelCost: sumMoney(rows.map((r) => mulMoney(r.qty, r.landedUnitCost))),
      short: rows.some((r) => r.lotId === null),
    })
    .where(eq(sales.id, saleId));
}

/**
 * Fills usage rows recorded while we were out of stock from lots that now
 * have poles (oldest first), and updates those sales' cost.
 */
/** The parts of a usage row to keep when splitting it. */
const usageCopy = (u: typeof steelUsage.$inferSelect) => ({
  steelItemId: u.steelItemId,
  reason: u.reason,
  saleId: u.saleId,
  usedOn: u.usedOn,
  note: u.note,
  createdBy: u.createdBy,
  landedUnitCost: u.landedUnitCost,
});

async function settleShortages(tx: Tx, steelItemId: string) {
  const open = await tx
    .select()
    .from(steelUsage)
    .where(and(eq(steelUsage.steelItemId, steelItemId), isNull(steelUsage.lotId), isNull(steelUsage.voidedAt)))
    .orderBy(asc(steelUsage.createdAt), asc(steelUsage.id))
    .for("update");
  if (open.length === 0) return;
  const lots = await openLots(tx, steelItemId);
  const touchedSales = new Set<string>();

  for (const u of open) {
    let need = u.qty;
    let first = true;
    for (const lot of lots) {
      if (need === 0) break;
      if (lot.qtyRemaining === 0) continue;
      const take = Math.min(need, lot.qtyRemaining);
      lot.qtyRemaining -= take;
      await tx.update(steelLots).set({ qtyRemaining: lot.qtyRemaining }).where(eq(steelLots.id, lot.id));
      if (first) {
        await tx.update(steelUsage).set({ lotId: lot.id, qty: take, landedUnitCost: lot.landedUnitCost }).where(eq(steelUsage.id, u.id));
        first = false;
      } else {
        await tx.insert(steelUsage).values({ ...usageCopy(u), lotId: lot.id, qty: take, landedUnitCost: lot.landedUnitCost });
      }
      need -= take;
    }
    if (first) break; // no stock left to settle with
    if (need > 0) {
      await tx.insert(steelUsage).values({ ...usageCopy(u), lotId: null, qty: need });
    }
    if (u.saleId) touchedSales.add(u.saleId);
  }
  for (const saleId of touchedSales) await refreshSaleCost(tx, saleId);
}

type NewLot = Omit<typeof steelLots.$inferInsert, "id" | "qtyRemaining" | "createdAt">;

/** Adds a cost lot (caller holds the item lock) and fills any open shortages from it. */
async function addLot(tx: Tx, lot: NewLot) {
  const [row] = await tx.insert(steelLots).values({ ...lot, qtyRemaining: lot.qty }).returning();
  await settleShortages(tx, lot.steelItemId);
  return row;
}

/**
 * Takes poles from the oldest lots (caller holds the item lock). If there
 * aren't enough and `allowShort`, the rest is recorded with no lot at the
 * latest known cost, to be filled in when stock arrives.
 */
export async function takeSteel(
  tx: Tx,
  actor: string,
  input: {
    steelItemId: string;
    qty: number;
    usedOn: string;
    reason: "sale" | "count_correction";
    saleId?: string;
    note?: string | null;
    allowShort: boolean;
  },
) {
  const lots = await openLots(tx, input.steelItemId);
  const available = lots.reduce((a, l) => a + l.qtyRemaining, 0);
  if (available < input.qty && !input.allowShort) {
    throw new UserError(`Only ${available} on hand — can't remove ${input.qty}.`);
  }
  const base = {
    steelItemId: input.steelItemId,
    reason: input.reason,
    saleId: input.saleId ?? null,
    usedOn: input.usedOn,
    note: input.note?.trim() || null,
    createdBy: actor,
  };
  let need = input.qty;
  for (const lot of lots) {
    if (need === 0) break;
    const take = Math.min(need, lot.qtyRemaining);
    await tx.update(steelLots).set({ qtyRemaining: lot.qtyRemaining - take }).where(eq(steelLots.id, lot.id));
    await tx.insert(steelUsage).values({ ...base, lotId: lot.id, qty: take, landedUnitCost: lot.landedUnitCost });
    need -= take;
  }
  if (need > 0) {
    const [latest] = await tx
      .select({ cost: steelLots.landedUnitCost })
      .from(steelLots)
      .where(eq(steelLots.steelItemId, input.steelItemId))
      .orderBy(desc(steelLots.receivedOn), desc(steelLots.createdAt))
      .limit(1);
    await tx.insert(steelUsage).values({ ...base, lotId: null, qty: need, landedUnitCost: latest?.cost ?? 0 });
  }
  return { short: need > 0 };
}

export { lockItems as lockSteelItems, refreshSaleCost, settleShortages };

// ── Receiving invoices ──

export type ReceiveResult = { status: "registered" | "duplicate"; lotIds: string[] };

/** Creates one lot per line in one transaction. Safe to repeat, like registerRolls. */
export async function receiveSteel(
  db: DB,
  documentId: string,
  plan: { lines: PlannedSteelLine[]; freight: number },
  opts: { actor: string; receivedOn?: string; reviewedBy?: string },
): Promise<ReceiveResult> {
  if (plan.lines.length === 0) throw new UserError("Add at least one line.");
  if (toUnits(plan.freight) < 0) throw new UserError("Freight can't be negative.");
  return db.transaction(async (tx) => {
    const { doc, already } = await lockDocument(tx, documentId);
    if (already === "duplicate") return { status: "duplicate", lotIds: [] };
    if (already === "registered") {
      const existing = await tx.select({ id: steelLots.id }).from(steelLots).where(eq(steelLots.sourceDocumentId, doc.id));
      return { status: "registered", lotIds: existing.map((l) => l.id) };
    }
    await lockItems(tx, plan.lines.map((l) => l.steelItemId));
    const receivedOn = opts.receivedOn ?? receivedOnFor(doc);
    const lotIds: string[] = [];
    for (const l of landedCosts(plan.lines, plan.freight)) {
      const lot = await addLot(tx, {
        steelItemId: l.steelItemId,
        source: "invoice",
        sourceDocumentId: doc.id,
        invoiceNumber: doc.invoiceNumber,
        receivedOn,
        qty: l.qty,
        unitCost: l.unitCost,
        freightPerUnit: l.freightPerUnit,
        landedUnitCost: l.landedUnitCost,
        note: l.label || null,
        createdBy: opts.actor,
      });
      lotIds.push(lot.id);
    }
    await markRegistered(tx, doc.id, { shippingCost: plan.freight }, opts.reviewedBy);
    return { status: "registered", lotIds };
  });
}

/** Automatic path for steel suppliers: receive when every line checks out, else flag for review. */
export async function autoReceiveSteel(db: DB, documentId: string) {
  const ready = await readyForAuto(db, documentId);
  if ("status" in ready) return { status: ready.status };
  const { doc, extraction } = ready;
  const mappings = await db.select().from(supplierSteelProducts).where(eq(supplierSteelProducts.supplierId, doc.supplierId));
  const plan = planSteel(extraction, mappings);
  if (!plan.ok) {
    await setDocumentStatus(db, doc.id, "needs_review", plan.reason);
    return { status: "needs_review" as const, reason: plan.reason };
  }
  return receiveSteel(db, doc.id, plan, { actor: "invoice-import" });
}

// ── Manual stock changes ──

/**
 * Opening balance or count correction. Adding poles needs their cost (it
 * becomes a lot); removing takes from the oldest lots and can't go below 0.
 */
export async function adjustSteel(
  db: DB,
  actor: string,
  input: {
    steelItemId: string;
    qty: number;
    reason: "opening_balance" | "count_correction";
    unitCost?: number | null;
    adjustedOn: string;
    note?: string | null;
  },
) {
  if (!Number.isInteger(input.qty) || input.qty === 0) throw new UserError("Change must be a whole number other than 0.");
  if (input.qty < 0 && input.reason === "opening_balance") throw new UserError("An opening balance can't be negative.");
  if (input.qty > 0 && (input.unitCost == null || input.unitCost < 0)) {
    throw new UserError("Enter the cost per pole for poles you're adding.");
  }
  await db.transaction(async (tx) => {
    await lockItems(tx, [input.steelItemId]);
    if (input.qty > 0) {
      await addLot(tx, {
        steelItemId: input.steelItemId,
        source: input.reason,
        receivedOn: input.adjustedOn,
        qty: input.qty,
        unitCost: input.unitCost as number,
        landedUnitCost: input.unitCost as number,
        note: input.note?.trim() || null,
        createdBy: actor,
      });
    } else {
      await takeSteel(tx, actor, {
        steelItemId: input.steelItemId,
        qty: -input.qty,
        usedOn: input.adjustedOn,
        reason: "count_correction",
        note: input.note,
        allowShort: false,
      });
    }
  });
}

// ── Settings ──

export async function createSteelItem(db: DB, input: { name: string; sortOrder?: number }) {
  const name = input.name.trim();
  if (!name) throw new UserError("Name is required.");
  const [dupe] = await db.select().from(steelItems).where(eq(steelItems.name, name));
  if (dupe) throw new UserError(`A steel item named "${name}" already exists.`);
  const [row] = await db.insert(steelItems).values({ name, sortOrder: input.sortOrder ?? 0 }).returning();
  return row;
}

export async function updateSteelItem(db: DB, id: string, input: { name: string; sortOrder: number; active: boolean }) {
  const name = input.name.trim();
  if (!name) throw new UserError("Name is required.");
  const clash = await db.select().from(steelItems).where(eq(steelItems.name, name));
  if (clash.some((s) => s.id !== id)) throw new UserError(`A steel item named "${name}" already exists.`);
  await db.update(steelItems).set({ ...input, name }).where(eq(steelItems.id, id));
}

/** Sets how many of a steel item a product uses; 0 removes it from the recipe. */
export async function setProductSteel(db: DB, input: { productId: string; steelItemId: string; qty: number }) {
  if (!Number.isInteger(input.qty) || input.qty < 0) throw new UserError("Quantity must be a whole number, 0 or more.");
  const where = and(eq(productSteel.productId, input.productId), eq(productSteel.steelItemId, input.steelItemId));
  if (input.qty === 0) {
    await db.delete(productSteel).where(where);
    return;
  }
  await db
    .insert(productSteel)
    .values(input)
    .onConflictDoUpdate({ target: [productSteel.productId, productSteel.steelItemId], set: { qty: input.qty } });
}

export async function addSupplierSteelProduct(
  db: DB,
  input: { supplierId: string; productCode?: string | null; descriptionMatch?: string | null; steelItemId: string },
) {
  const productCode = input.productCode?.trim() || null;
  const descriptionMatch = input.descriptionMatch?.trim() || null;
  if (!productCode && !descriptionMatch) throw new UserError("Enter a product code or description text to match.");
  if (productCode) {
    const [dupe] = await db
      .select()
      .from(supplierSteelProducts)
      .where(and(eq(supplierSteelProducts.supplierId, input.supplierId), eq(supplierSteelProducts.productCode, productCode)));
    if (dupe) throw new UserError(`Product code ${productCode} is already set up.`);
  }
  await db.insert(supplierSteelProducts).values({ ...input, productCode, descriptionMatch });
}

export async function removeSupplierSteelProduct(db: DB, id: string) {
  await db.delete(supplierSteelProducts).where(eq(supplierSteelProducts.id, id));
}

// ── Reads ──

/** Each steel item with what's on hand and what it's worth at FIFO landed cost. */
export async function steelSummary(db: DB) {
  const items = await db.select().from(steelItems).orderBy(asc(steelItems.sortOrder), asc(steelItems.name));
  const lots = await db
    .select({
      steelItemId: steelLots.steelItemId,
      remaining: sql<number>`coalesce(sum(${steelLots.qtyRemaining}), 0)::int`,
      value: sql<number>`coalesce(sum(${steelLots.qtyRemaining} * ${steelLots.landedUnitCost}), 0)::float`,
    })
    .from(steelLots)
    .groupBy(steelLots.steelItemId);
  const short = await db
    .select({ steelItemId: steelUsage.steelItemId, qty: sql<number>`sum(${steelUsage.qty})::int` })
    .from(steelUsage)
    .where(and(isNull(steelUsage.lotId), isNull(steelUsage.voidedAt)))
    .groupBy(steelUsage.steelItemId);
  const latest = await db
    .selectDistinctOn([steelLots.steelItemId], { steelItemId: steelLots.steelItemId, cost: steelLots.landedUnitCost })
    .from(steelLots)
    .orderBy(steelLots.steelItemId, desc(steelLots.receivedOn), desc(steelLots.createdAt));

  return items.map((item) => {
    const l = lots.find((x) => x.steelItemId === item.id);
    const owed = short.find((x) => x.steelItemId === item.id)?.qty ?? 0;
    return {
      ...item,
      onHand: (l?.remaining ?? 0) - owed,
      value: fromUnits(Math.round(toUnits(l?.value ?? 0))),
      latestCost: latest.find((x) => x.steelItemId === item.id)?.cost ?? null,
    };
  });
}

/** Recent lots added (invoices, opening balances, corrections) and poles removed by corrections. */
export async function steelActivity(db: DB, limit = 25) {
  const [lots, removals] = await Promise.all([
    db
      .select({ lot: steelLots, name: steelItems.name })
      .from(steelLots)
      .innerJoin(steelItems, eq(steelLots.steelItemId, steelItems.id))
      .orderBy(desc(steelLots.createdAt))
      .limit(limit),
    db
      .select({ usage: steelUsage, name: steelItems.name })
      .from(steelUsage)
      .innerJoin(steelItems, eq(steelUsage.steelItemId, steelItems.id))
      .where(and(eq(steelUsage.reason, "count_correction"), isNull(steelUsage.voidedAt)))
      .orderBy(desc(steelUsage.createdAt))
      .limit(limit),
  ]);
  return { lots, removals };
}
