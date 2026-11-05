// Supplier documents → rolls. Matching is pure (planRolls); registration is one
// transaction that is safe to repeat (registerRolls).
import { todayInMichigan } from "@lacey-factory/shared/feet";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

import { materials, rolls, supplierDocuments, supplierProducts, suppliers } from "../db/schema";
import type { DB } from "../db/types";
import type { DocumentExtraction } from "../temporal/extract";
import { UserError } from "./errors";
import { createRoll } from "./services";

export type SupplierProduct = typeof supplierProducts.$inferSelect;
export type PlannedRoll = { materialId: string; widthFt: number; lengthFt: number; supplierRollNo: string | null };
export type RollPlan = { ok: true; rolls: PlannedRoll[] } | { ok: false; reason: string };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const ROLL_UOM = /^(roll|rolls|rl|rls)$/i;

function findProduct(line: DocumentExtraction["lines"][number], products: SupplierProduct[]) {
  const code = norm(line.product_code);
  if (code) {
    const byCode = products.find((p) => norm(p.productCode) === code);
    if (byCode) return { product: byCode };
  }
  const desc = norm(line.description);
  const byDesc = products.filter((p) => p.descriptionMatch && desc.includes(norm(p.descriptionMatch)));
  if (byDesc.length === 1) return { product: byDesc[0] };
  if (byDesc.length > 1) return { ambiguous: true as const };
  return {};
}

/** A line with no code, size or roll numbers is a charge (freight, fees), not a product. */
function isChargeLine(line: DocumentExtraction["lines"][number]) {
  return !line.product_code && line.width_ft == null && line.length_ft == null && line.roll_numbers.length === 0;
}

/**
 * Turns a document's lines into rolls to register, or explains why a person
 * needs to look at it. Every product line must map to a known supplier
 * product and have a clear roll count.
 */
export function planRolls(doc: DocumentExtraction, products: SupplierProduct[]): RollPlan {
  if (!doc.is_invoice_or_packing_list) return { ok: false, reason: "Not an invoice or packing list." };
  const out: PlannedRoll[] = [];
  const lines = doc.lines.filter((l) => !isChargeLine(l));
  if (lines.length === 0) return { ok: false, reason: "No product lines found." };

  for (const line of lines) {
    const label = line.product_code ? `${line.product_code} ${line.description}` : line.description;
    const found = findProduct(line, products);
    if ("ambiguous" in found) return { ok: false, reason: `"${label}" matches more than one product.` };
    if (!found.product) return { ok: false, reason: `Unknown product "${label}". Add it under Settings → Suppliers.` };
    const p = found.product;
    if ((line.width_ft != null && line.width_ft !== p.widthFt) || (line.length_ft != null && line.length_ft !== p.lengthFt)) {
      return {
        ok: false,
        reason: `"${label}" says ${line.width_ft ?? "?"}'×${line.length_ft ?? "?"}' but the product is set up as ${p.widthFt}'×${p.lengthFt}'.`,
      };
    }

    let numbers: (string | null)[];
    if (line.roll_numbers.length > 0) {
      if (line.quantity != null && ROLL_UOM.test(line.uom ?? "") && line.quantity !== line.roll_numbers.length) {
        return { ok: false, reason: `"${label}" lists ${line.roll_numbers.length} roll numbers but a quantity of ${line.quantity}.` };
      }
      numbers = line.roll_numbers;
    } else if (line.quantity != null && Number.isInteger(line.quantity) && line.quantity > 0 && ROLL_UOM.test(line.uom ?? "")) {
      numbers = Array.from({ length: line.quantity }, () => null);
    } else {
      return { ok: false, reason: `Can't tell how many rolls "${label}" is (quantity ${line.quantity ?? "?"} ${line.uom ?? ""}).` };
    }
    for (const n of numbers) out.push({ materialId: p.materialId, widthFt: p.widthFt, lengthFt: p.lengthFt, supplierRollNo: n });
  }

  const tickets = out.map((r) => r.supplierRollNo).filter(Boolean);
  if (new Set(tickets).size !== tickets.length) return { ok: false, reason: "The same roll number appears twice." };
  return { ok: true, rolls: out };
}

const isoDate = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

/** Rolls are dated when they ship: ship date, else document date, else the day the email came. */
export function receivedOnFor(doc: { shipDate: string | null; invoiceDate: string | null; emailReceivedAt: Date }) {
  return isoDate(doc.shipDate) ?? isoDate(doc.invoiceDate) ?? todayInMichigan(doc.emailReceivedAt);
}

// ── Suppliers ──

/** The active supplier whose patterns match this sender (exact address or @domain). */
export async function matchSupplier(db: DB, senderEmail: string) {
  const email = norm(senderEmail);
  const domain = email.slice(email.lastIndexOf("@"));
  const all = await db.select().from(suppliers).where(eq(suppliers.active, true));
  return all.find((s) => s.emailPatterns.some((p) => norm(p) === email || norm(p) === domain)) ?? null;
}

export async function listSuppliers(db: DB) {
  const [rows, products] = await Promise.all([
    db.select().from(suppliers).orderBy(asc(suppliers.name)),
    db
      .select({ product: supplierProducts, materialName: materials.name })
      .from(supplierProducts)
      .innerJoin(materials, eq(supplierProducts.materialId, materials.id))
      .orderBy(asc(supplierProducts.productCode)),
  ]);
  return rows.map((s) => ({ ...s, products: products.filter((p) => p.product.supplierId === s.id) }));
}

export function parsePatterns(raw: string): string[] {
  const out = raw
    .split(/[\s,]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const p of out) {
    if (!/^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(p)) throw new UserError(`"${p}" isn't an email address or @domain.`);
  }
  if (out.length === 0) throw new UserError("Add at least one email address or @domain.");
  return out;
}

export async function saveSupplier(db: DB, input: { id?: string; name: string; emailPatterns: string; active?: boolean }) {
  const values = { name: input.name.trim(), kind: "rolls" as const, emailPatterns: parsePatterns(input.emailPatterns), active: input.active ?? true };
  if (!values.name) throw new UserError("Name is required.");
  const clash = await db.select().from(suppliers).where(eq(suppliers.name, values.name));
  if (clash.some((s) => s.id !== input.id)) throw new UserError(`A supplier named "${values.name}" already exists.`);
  if (input.id) {
    await db.update(suppliers).set(values).where(eq(suppliers.id, input.id));
    return input.id;
  }
  const [row] = await db.insert(suppliers).values(values).returning();
  return row.id;
}

export async function addSupplierProduct(
  db: DB,
  input: { supplierId: string; productCode?: string | null; descriptionMatch?: string | null; materialId: string; widthFt: number; lengthFt: number },
) {
  const productCode = input.productCode?.trim() || null;
  const descriptionMatch = input.descriptionMatch?.trim() || null;
  if (!productCode && !descriptionMatch) throw new UserError("Enter a product code or description text to match.");
  if (productCode) {
    const [dupe] = await db
      .select()
      .from(supplierProducts)
      .where(and(eq(supplierProducts.supplierId, input.supplierId), eq(supplierProducts.productCode, productCode)));
    if (dupe) throw new UserError(`Product code ${productCode} is already set up.`);
  }
  await db.insert(supplierProducts).values({ ...input, productCode, descriptionMatch });
}

export async function removeSupplierProduct(db: DB, id: string) {
  await db.delete(supplierProducts).where(eq(supplierProducts.id, id));
}

// ── Documents ──

export type NewDocument = Omit<typeof supplierDocuments.$inferInsert, "id" | "status" | "createdAt">;

/** Records an archived attachment once; returns the existing row on repeats. */
export async function recordDocument(db: DB, doc: NewDocument) {
  await db.insert(supplierDocuments).values(doc).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(supplierDocuments)
    .where(and(eq(supplierDocuments.gmailMessageId, doc.gmailMessageId), eq(supplierDocuments.sha256, doc.sha256)));
  return row;
}

export async function getDocument(db: DB, id: string) {
  const [row] = await db.select().from(supplierDocuments).where(eq(supplierDocuments.id, id));
  return row;
}

export async function saveExtraction(db: DB, id: string, x: DocumentExtraction) {
  await db
    .update(supplierDocuments)
    .set({
      extracted: x,
      documentType: x.document_type,
      invoiceNumber: x.invoice_number?.trim() || null,
      invoiceDate: isoDate(x.invoice_date),
      shipDate: isoDate(x.ship_date),
    })
    .where(eq(supplierDocuments.id, id));
}

export async function setDocumentStatus(
  db: DB,
  id: string,
  status: "needs_review" | "not_invoice" | "failed",
  reason: string | null,
  reviewedBy?: string,
) {
  await db
    .update(supplierDocuments)
    .set({ status, reviewReason: reason, ...(reviewedBy ? { reviewedBy, reviewedAt: new Date() } : {}) })
    .where(eq(supplierDocuments.id, id));
}

export type RegisterResult = { status: "registered" | "duplicate"; rollIds: string[] };

/**
 * Creates the document's rolls in one transaction. Safe to call again: a
 * registered document returns its rolls, and an invoice number already
 * registered from another email is marked duplicate instead.
 */
export async function registerRolls(
  db: DB,
  documentId: string,
  planned: PlannedRoll[],
  opts: { actor: string; receivedOn?: string; reviewedBy?: string },
): Promise<RegisterResult> {
  if (planned.length === 0) throw new UserError("Add at least one roll.");
  return db.transaction(async (tx) => {
    const [doc] = await tx.select().from(supplierDocuments).where(eq(supplierDocuments.id, documentId)).for("update");
    if (!doc) throw new UserError("Document not found.");
    if (doc.status === "registered") {
      const existing = await tx.select({ id: rolls.id }).from(rolls).where(eq(rolls.sourceDocumentId, doc.id));
      return { status: "registered", rollIds: existing.map((r) => r.id) };
    }
    if (doc.invoiceNumber) {
      const [other] = await tx
        .select({ id: supplierDocuments.id })
        .from(supplierDocuments)
        .where(
          and(
            eq(supplierDocuments.supplierId, doc.supplierId),
            eq(supplierDocuments.invoiceNumber, doc.invoiceNumber),
            eq(supplierDocuments.status, "registered"),
            ne(supplierDocuments.id, doc.id),
          ),
        );
      if (other) {
        await tx
          .update(supplierDocuments)
          .set({ status: "duplicate", reviewReason: `Invoice ${doc.invoiceNumber} was already registered from another email.` })
          .where(eq(supplierDocuments.id, doc.id));
        return { status: "duplicate", rollIds: [] };
      }
    }

    const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, doc.supplierId));
    const receivedOn = opts.receivedOn ?? receivedOnFor(doc);
    const ref = doc.invoiceNumber ? `#${doc.invoiceNumber}` : `from ${doc.filename}`;
    const rollIds: string[] = [];
    for (const r of planned) {
      const roll = await createRoll(tx as unknown as DB, opts.actor, {
        materialId: r.materialId,
        supplierRollNo: r.supplierRollNo,
        supplier: supplier?.name ?? null,
        widthFt: r.widthFt,
        lengthFt: r.lengthFt,
        receivedOn,
        notes: `${doc.documentType === "packing_list" ? "Packing list" : "Invoice"} ${ref}`,
      });
      await tx.update(rolls).set({ sourceDocumentId: doc.id }).where(eq(rolls.id, roll.id));
      rollIds.push(roll.id);
    }
    await tx
      .update(supplierDocuments)
      .set({
        status: "registered",
        reviewReason: null,
        ...(opts.reviewedBy ? { reviewedBy: opts.reviewedBy, reviewedAt: new Date() } : {}),
      })
      .where(eq(supplierDocuments.id, doc.id));
    return { status: "registered", rollIds };
  });
}

/** Automatic path: plan from the stored extraction, then register or flag for review. */
export async function autoRegister(db: DB, documentId: string) {
  const doc = await getDocument(db, documentId);
  if (!doc) throw new Error(`Document ${documentId} not found`);
  if (doc.status !== "processing") return { status: doc.status };
  const extraction = doc.extracted as DocumentExtraction | null;
  if (!extraction) {
    await setDocumentStatus(db, doc.id, "needs_review", "The document couldn't be read.");
    return { status: "needs_review" as const };
  }
  if (!extraction.is_invoice_or_packing_list) {
    await setDocumentStatus(db, doc.id, "not_invoice", null);
    return { status: "not_invoice" as const };
  }
  const products = await db.select().from(supplierProducts).where(eq(supplierProducts.supplierId, doc.supplierId));
  const plan = planRolls(extraction, products);
  if (!plan.ok) {
    await setDocumentStatus(db, doc.id, "needs_review", plan.reason);
    return { status: "needs_review" as const, reason: plan.reason };
  }
  return registerRolls(db, doc.id, plan.rolls, { actor: "invoice-import" });
}

export async function listDocuments(db: DB, limit = 100) {
  const docs = await db
    .select({ doc: supplierDocuments, supplierName: suppliers.name })
    .from(supplierDocuments)
    .innerJoin(suppliers, eq(supplierDocuments.supplierId, suppliers.id))
    .orderBy(desc(supplierDocuments.createdAt))
    .limit(limit);
  const ids = docs.map((d) => d.doc.id);
  const linked = ids.length
    ? await db
        .select({ id: rolls.id, appCode: rolls.appCode, sourceDocumentId: rolls.sourceDocumentId })
        .from(rolls)
        .where(inArray(rolls.sourceDocumentId, ids))
        .orderBy(asc(rolls.seq))
    : [];
  return docs.map(({ doc, supplierName }) => ({
    ...doc,
    supplierName,
    rolls: linked.filter((r) => r.sourceDocumentId === doc.id).map((r) => ({ id: r.id, appCode: r.appCode })),
  }));
}
