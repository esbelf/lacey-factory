// What happens to a read document depends on the supplier's kind. To add a
// supplier type (e.g. parts): add the enum value in db/schema.ts, a handler
// file here, and register it below. The workflow doesn't change.
import type { DB } from "../../db/types";
import { autoRegister, type SupplierKind } from "../../domain/invoices";
import { autoReceiveSteel } from "../../domain/steel";

export type { SupplierKind };
export type HandlerResult = { status: string; reason?: string };
export type DocumentHandler = (db: DB, documentId: string) => Promise<HandlerResult>;

export const HANDLERS: Record<SupplierKind, DocumentHandler> = {
  /** Rolls supplier: register the rolls when every line matches, else flag for review. */
  rolls: (db, id) => autoRegister(db, id),
  /** Steel supplier: add the poles as cost lots (freight spread in) when every line checks out, else flag for review. */
  steel: (db, id) => autoReceiveSteel(db, id),
};
