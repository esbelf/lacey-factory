// Reads a supplier document (PDF or photo) with Claude and returns its line items.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ApplicationFailure } from "@temporalio/activity";
import { z } from "zod";

export const DocumentExtraction = z.object({
  is_invoice_or_packing_list: z
    .boolean()
    .describe("True if this is an invoice, packing list or delivery note for goods sold to us"),
  document_type: z.enum(["invoice", "packing_list", "other"]),
  invoice_number: z
    .string()
    .nullable()
    .describe("The invoice number, or for a packing list its order/document number, exactly as printed; null if none"),
  invoice_date: z.string().nullable().describe("Document date as YYYY-MM-DD, or null"),
  ship_date: z.string().nullable().describe("Ship date as YYYY-MM-DD if printed separately, or null"),
  lines: z
    .array(
      z.object({
        product_code: z.string().nullable().describe("Supplier product/item code (e.g. 38151), or null"),
        description: z.string().describe("Line description exactly as printed"),
        quantity: z.number().nullable().describe("Quantity on this line, or null"),
        uom: z.string().nullable().describe("Unit of measure as printed (ROLL, SY, EA, ...), or null"),
        width_ft: z.number().nullable().describe("Roll width in feet if the description gives it (12.5' → 12.5), or null"),
        length_ft: z.number().nullable().describe("Roll length in feet if the description gives it (360' → 360), or null"),
        roll_numbers: z
          .array(z.string())
          .describe("Individual roll / ticket numbers listed for this line (e.g. 3260925338V); empty if none"),
      }),
    )
    .describe("One entry per product line. If each roll is printed on its own row, return one line per row."),
});
export type DocumentExtraction = z.infer<typeof DocumentExtraction>;

export interface DocumentReader {
  read(doc: Buffer, mimeType: string, hint: { supplierName: string }): Promise<DocumentExtraction>;
}

const PROMPT = `This document came by email from one of our suppliers. Read it and return its line items.
Use exactly what is printed. If a value isn't on the document, return null rather than guessing.
Dates on these US documents are month-first (09/16/2026 is 2026-09-16).
Ignore summary rows such as subtotals, totals and price breakdowns like "(4 X 545.0000=$2,180.00)".`;

export class ClaudeDocumentReader implements DocumentReader {
  // Temporal owns retries, so the SDK makes one attempt.
  private client = new Anthropic({ maxRetries: 0, timeout: 120_000 });
  constructor(private model: string) {}

  async read(doc: Buffer, mimeType: string, hint: { supplierName: string }): Promise<DocumentExtraction> {
    const data = doc.toString("base64");
    const source: Anthropic.Beta.BetaContentBlockParam =
      mimeType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: mimeType as "image/jpeg" | "image/png", data } };
    try {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        // If a safety classifier declines, the API re-runs the request on its recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: betaZodOutputFormat(DocumentExtraction) },
        messages: [{ role: "user", content: [source, { type: "text", text: `${PROMPT}\nSupplier: ${hint.supplierName}` }] }],
      });
      if (res.stop_reason === "refusal") {
        throw ApplicationFailure.nonRetryable("Claude declined to read this document", "ClaudeRefusal");
      }
      if (!res.parsed_output) throw new Error(`Claude returned no structured output (stop_reason=${res.stop_reason})`);
      return res.parsed_output;
    } catch (err) {
      // 400/401/403/404 won't succeed on retry; 429/5xx/network errors will.
      if (
        err instanceof Anthropic.BadRequestError ||
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError ||
        err instanceof Anthropic.NotFoundError
      ) {
        throw ApplicationFailure.nonRetryable(`Claude: ${err.message}`, "ClaudeRequestError");
      }
      // No credentials configured (client-side config error, raised before any request).
      if (!(err instanceof Anthropic.APIError) && err instanceof Error && /authentication method/i.test(err.message)) {
        throw ApplicationFailure.nonRetryable("No Anthropic API key is configured (ANTHROPIC_API_KEY).", "ClaudeNotConfigured");
      }
      throw err;
    }
  }
}
