// What Claude returns for ../../hanes-doc-chris-receives.pdf (Hanes packing list 084-51752).
import type { DocumentExtraction } from "../../src/temporal/extract";

const roll = (ticket: string) => ({
  product_code: "38151",
  description: "TERRATEX N06 12.5'X360' 500 SY",
  quantity: 1,
  uom: "ROLL",
  width_ft: 12.5,
  length_ft: 360,
  roll_numbers: [ticket],
});

export const hanesPackingList: DocumentExtraction = {
  is_invoice_or_packing_list: true,
  document_type: "packing_list",
  invoice_number: "084-51752",
  invoice_date: "2026-09-16",
  ship_date: null,
  lines: ["3260925338V", "3260925339W", "3260925340P", "3260925341Q"].map(roll),
};

export const hanesInvoice: DocumentExtraction = {
  is_invoice_or_packing_list: true,
  document_type: "invoice",
  invoice_number: "INV-77001",
  invoice_date: "2026-09-17",
  ship_date: "2026-09-16",
  lines: [
    { product_code: "38151", description: "TERRATEX N06 12.5'X360' 500 SY", quantity: 4, uom: "ROLL", width_ft: 12.5, length_ft: 360, roll_numbers: [] },
    { product_code: null, description: "FREIGHT", quantity: null, uom: null, width_ft: null, length_ft: null, roll_numbers: [] },
  ],
};
