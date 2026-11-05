// Supplier documents → rolls: matching rules and registration on a real Postgres (PGlite).
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema";
import type { DB } from "../src/db/types";
import { loadCatalog } from "../src/domain/catalog";
import {
  autoRegister,
  matchSupplier,
  parsePatterns,
  planRolls,
  receivedOnFor,
  recordDocument,
  saveExtraction,
  saveSupplier,
  type SupplierProduct,
} from "../src/domain/invoices";
import { hanesInvoice, hanesPackingList } from "./fixtures/hanes-extraction";

const product: SupplierProduct = {
  id: "p1",
  supplierId: "s1",
  productCode: "38151",
  descriptionMatch: "TERRATEX N06",
  materialId: "m1",
  widthFt: 12.5,
  lengthFt: 360,
  createdAt: new Date(),
};

describe("planRolls", () => {
  it("registers one roll per ticket on the Hanes packing list", () => {
    const plan = planRolls(hanesPackingList, [product]);
    expect(plan).toEqual({
      ok: true,
      rolls: ["3260925338V", "3260925339W", "3260925340P", "3260925341Q"].map((n) => ({
        materialId: "m1",
        widthFt: 12.5,
        lengthFt: 360,
        supplierRollNo: n,
      })),
    });
  });

  it("uses the quantity when an invoice gives a roll count, and skips charge lines", () => {
    const plan = planRolls(hanesInvoice, [product]);
    expect(plan.ok && plan.rolls.length).toBe(4);
    expect(plan.ok && plan.rolls.every((r) => r.supplierRollNo === null)).toBe(true);
  });

  it("falls back to the description when the code is missing", () => {
    const doc = { ...hanesInvoice, lines: [{ ...hanesInvoice.lines[0], product_code: null }] };
    expect(planRolls(doc, [product]).ok).toBe(true);
  });

  it("sends unknown products, size mismatches and unclear counts to review", () => {
    const line = hanesInvoice.lines[0];
    const unknown = planRolls({ ...hanesInvoice, lines: [{ ...line, product_code: "99999", description: "GEOGRID" }] }, [product]);
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringMatching(/Unknown product/) });

    const wrongSize = planRolls({ ...hanesInvoice, lines: [{ ...line, length_ft: 300 }] }, [product]);
    expect(wrongSize).toMatchObject({ ok: false, reason: expect.stringMatching(/300/) });

    const squareYards = planRolls({ ...hanesInvoice, lines: [{ ...line, quantity: 2000, uom: "SY" }] }, [product]);
    expect(squareYards).toMatchObject({ ok: false, reason: expect.stringMatching(/how many rolls/) });

    const mismatch = planRolls({ ...hanesInvoice, lines: [{ ...line, roll_numbers: ["A1", "A2"] }] }, [product]);
    expect(mismatch).toMatchObject({ ok: false, reason: expect.stringMatching(/2 roll numbers/) });
  });

  it("rejects documents that aren't invoices", () => {
    expect(planRolls({ ...hanesInvoice, is_invoice_or_packing_list: false }, [product]).ok).toBe(false);
  });
});

describe("receivedOnFor", () => {
  const emailReceivedAt = new Date("2026-09-18T15:00:00Z");
  it("prefers ship date, then document date, then the email's day", () => {
    expect(receivedOnFor({ shipDate: "2026-09-16", invoiceDate: "2026-09-17", emailReceivedAt })).toBe("2026-09-16");
    expect(receivedOnFor({ shipDate: null, invoiceDate: "2026-09-17", emailReceivedAt })).toBe("2026-09-17");
    expect(receivedOnFor({ shipDate: null, invoiceDate: "09/17/2026", emailReceivedAt })).toBe("2026-09-18");
  });
});

describe("supplier email patterns", () => {
  it("accepts addresses and @domains, rejects junk", () => {
    expect(parsePatterns(" Billing@Hanes.com, @hanesgeo.com ")).toEqual(["billing@hanes.com", "@hanesgeo.com"]);
    expect(() => parsePatterns("hanes")).toThrow(/isn't an email/);
    expect(() => parsePatterns("")).toThrow(/at least one/);
  });
});

describe("registering rolls from documents", () => {
  let db: DB;
  let supplierId: string;
  let n = 0;

  async function newDoc(extraction = hanesPackingList) {
    n++;
    const doc = await recordDocument(db, {
      supplierId,
      account: "eric@lakemat.com",
      gmailMessageId: `msg-${n}`,
      sha256: `sha-${n}`,
      filename: "packing.pdf",
      mimeType: "application/pdf",
      emailFrom: "Hanes <orders@hanesgeo.com>",
      emailSubject: "Packing list",
      emailReceivedAt: new Date("2026-09-18T15:00:00Z"),
      s3Key: `suppliers/hanes/${n}.pdf`,
    });
    await saveExtraction(db, doc.id, extraction);
    return doc.id;
  }

  beforeAll(async () => {
    const pg = drizzle(new PGlite(), { schema });
    await migrate(pg, { migrationsFolder: "drizzle" });
    db = pg as unknown as DB;
    await loadCatalog(db);
    const [hanes] = await db.select().from(schema.suppliers);
    supplierId = await saveSupplier(db, { id: hanes.id, name: hanes.name, emailPatterns: "@hanesgeo.com" });
  });

  it("matches the supplier by sender domain", async () => {
    expect((await matchSupplier(db, "orders@hanesgeo.com"))?.name).toBe("Hanes Geo Components");
    expect(await matchSupplier(db, "someone@gmail.com")).toBeNull();
  });

  it("registers the four Hanes rolls once, linked to the document", async () => {
    const id = await newDoc();
    const first = await autoRegister(db, id);
    expect(first).toMatchObject({ status: "registered" });

    const rolls = await db.select().from(schema.rolls).where(eq(schema.rolls.sourceDocumentId, id));
    expect(rolls.map((r) => r.supplierRollNo).sort()).toEqual(["3260925338V", "3260925339W", "3260925340P", "3260925341Q"]);
    expect(rolls[0]).toMatchObject({ widthFt: 12.5, lengthFt: 360, receivedOn: "2026-09-16", supplier: "Hanes Geo Components", createdBy: "invoice-import" });

    // Running it again (a Temporal retry) changes nothing.
    expect(await autoRegister(db, id)).toMatchObject({ status: "registered" });
    expect(await db.select().from(schema.rolls)).toHaveLength(4);
  });

  it("marks the same invoice number from another email as a duplicate", async () => {
    const id = await newDoc();
    expect(await autoRegister(db, id)).toMatchObject({ status: "duplicate" });
    expect(await db.select().from(schema.rolls)).toHaveLength(4);
  });

  it("flags documents it can't match for review", async () => {
    const id = await newDoc({ ...hanesInvoice, invoice_number: "INV-2", lines: [{ ...hanesInvoice.lines[0], product_code: "1", description: "MYSTERY" }] });
    expect(await autoRegister(db, id)).toMatchObject({ status: "needs_review" });
    const [doc] = await db.select().from(schema.supplierDocuments).where(eq(schema.supplierDocuments.id, id));
    expect(doc.reviewReason).toMatch(/Unknown product/);
  });
});
