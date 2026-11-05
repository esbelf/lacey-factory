import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const feet = (name: string) => numeric(name, { precision: 8, scale: 2, mode: "number" });

export const pieceStatus = pgEnum("piece_status", ["cut", "at_summit", "in_stock"]);
export const sewnBy = pgEnum("sewn_by", ["in_house", "summit", "not_sewn"]);
export const adjustmentReason = pgEnum("adjustment_reason", [
  "opening_balance",
  "count_correction",
  "sale",
  "other",
]);

/** A kind of roll material, e.g. a weed-barrier fabric or geogrid. */
export const materials = pgTable(
  "materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    // Geogrid doesn't get sewn: its cut pieces go straight to inventory.
    requiresSewing: boolean("requires_sewing").notNull().default(true),
    defaultWidthFt: feet("default_width_ft"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("materials_name_unique").on(t.name)],
);

/** A size we cut from a material. The cut length is fixed per size. */
export const cutSizes = pgTable(
  "cut_sizes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id),
    label: text("label").notNull(), // e.g. "12x24"
    widthFt: feet("width_ft").notNull(),
    cutLengthFt: feet("cut_length_ft").notNull(), // length taken off the roll, e.g. 26
    productFamily: text("product_family"), // e.g. "LakeMat / MuckMat XL"
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cut_sizes_material_label_unique").on(t.materialId, t.label)],
);

export const rolls = pgTable(
  "rolls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    seq: serial("seq").notNull(),
    appCode: text("app_code")
      .generatedAlwaysAs(sql`'R-' || lpad(seq::text, 4, '0')`)
      .notNull(),
    supplierRollNo: text("supplier_roll_no"),
    supplier: text("supplier"),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id),
    widthFt: feet("width_ft").notNull(),
    lengthFt: feet("length_ft").notNull(),
    receivedOn: date("received_on", { mode: "string" }).notNull(),
    // Set when the roll is used up. Leftover is measured by hand so we can
    // compare it to the computed remaining length.
    closedOn: date("closed_on", { mode: "string" }),
    leftoverFtMeasured: feet("leftover_ft_measured"),
    notes: text("notes"),
    // Set when the roll was registered from a supplier invoice email.
    sourceDocumentId: uuid("source_document_id").references(() => supplierDocuments.id),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("rolls_app_code_unique").on(t.appCode)],
);

/** One cutting form submission against a roll. */
export const cutSessions = pgTable("cut_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  rollId: uuid("roll_id")
    .notNull()
    .references(() => rolls.id),
  cutOn: date("cut_on", { mode: "string" }).notNull(),
  notes: text("notes"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
});

/** A batch of pieces marked as sewn in-house on one date. */
export const sewBatches = pgTable("sew_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  sewnOn: date("sewn_on", { mode: "string" }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
});

export const summitShipments = pgTable("summit_shipments", {
  id: uuid("id").defaultRandom().primaryKey(),
  sentOn: date("sent_on", { mode: "string" }).notNull(),
  notes: text("notes"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
});

export const summitReceipts = pgTable("summit_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  cutSizeId: uuid("cut_size_id")
    .notNull()
    .references(() => cutSizes.id),
  qty: integer("qty").notNull(),
  receivedOn: date("received_on", { mode: "string" }).notNull(),
  notes: text("notes"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
});

/** One row per physical cut piece. */
export const pieces = pgTable(
  "pieces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cutSessionId: uuid("cut_session_id")
      .notNull()
      .references(() => cutSessions.id),
    rollId: uuid("roll_id")
      .notNull()
      .references(() => rolls.id),
    cutSizeId: uuid("cut_size_id")
      .notNull()
      .references(() => cutSizes.id),
    cutLengthFt: feet("cut_length_ft").notNull(), // copied at cut time
    cutOn: date("cut_on", { mode: "string" }).notNull(), // copied for FIFO ordering
    status: pieceStatus("status").notNull().default("cut"),
    sewnBy: sewnBy("sewn_by"),
    sewnOn: date("sewn_on", { mode: "string" }),
    sewBatchId: uuid("sew_batch_id").references(() => sewBatches.id),
    summitShipmentId: uuid("summit_shipment_id").references(() => summitShipments.id),
    summitReceiptId: uuid("summit_receipt_id").references(() => summitReceipts.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("pieces_roll_idx").on(t.rollId),
    index("pieces_size_status_idx").on(t.cutSizeId, t.status),
  ],
);

/** Manual stock changes: opening balance, count corrections, later sales. */
export const inventoryAdjustments = pgTable("inventory_adjustments", {
  id: uuid("id").defaultRandom().primaryKey(),
  cutSizeId: uuid("cut_size_id")
    .notNull()
    .references(() => cutSizes.id),
  qty: integer("qty").notNull(), // + adds stock, - removes
  reason: adjustmentReason("reason").notNull(),
  adjustedOn: date("adjusted_on", { mode: "string" }).notNull(),
  note: text("note"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

/**
 * A product we sell (e.g. "MuckMat XL") and the sewn/cut pieces it uses.
 * Nothing is reserved for a product until it sells; this is the recipe the
 * later sales step will use to take pieces out of inventory.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    productLine: text("product_line").notNull(), // e.g. "MuckMat", "Boatlift Mat"
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("products_name_unique").on(t.name)],
);

export const productComponents = pgTable(
  "product_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    cutSizeId: uuid("cut_size_id")
      .notNull()
      .references(() => cutSizes.id),
    qty: integer("qty").notNull().default(1), // e.g. Boatlift Extreme uses 2
  },
  (t) => [uniqueIndex("product_components_unique").on(t.productId, t.cutSizeId)],
);

export const userRole = pgEnum("user_role", ["admin", "regular", "factory"]);

/**
 * Everyone who has signed in. Created on first sign-in as a factory worker;
 * the admin promotes people in the Users dashboard. eric@lakemat.com is
 * always admin (see ADMIN_EMAIL in @lacey-factory/shared/permissions).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: userRole("role").notNull().default("factory"),
    roleChangedBy: text("role_changed_by"),
    roleChangedAt: timestamp("role_changed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

// ───────────── Supplier emails → invoices ─────────────

export const emailAccountStatus = pgEnum("email_account_status", ["connected", "needs_reauth", "disconnected"]);

/** The Gmail mailbox we read supplier emails from (eric@lakemat.com). */
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    /** Google refresh token, AES-256-GCM encrypted with EMAIL_TOKEN_KEY. */
    refreshTokenEnc: text("refresh_token_enc"),
    status: emailAccountStatus("status").notNull().default("disconnected"),
    historyId: text("history_id"),
    watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true }),
    connectedBy: text("connected_by"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("email_accounts_email_unique").on(t.email)],
);

/** One-time state for the Google OAuth redirect (the callback has no app login). */
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  userEmail: text("user_email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** What a supplier sends us. Each kind has its own handler in api/src/temporal/handlers. */
export const supplierKind = pgEnum("supplier_kind", ["rolls"]);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    kind: supplierKind("kind").notNull(),
    /** Sender addresses ("billing@hanes.com") or whole domains ("@hanesgeo.com"). */
    emailPatterns: text("email_patterns").array().notNull().default(sql`'{}'::text[]`),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("suppliers_name_unique").on(t.name)],
);

/** How a supplier's product line maps to one of our rolls (e.g. Hanes 38151 → TerraTex N06 12.5×360). */
export const supplierProducts = pgTable(
  "supplier_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    productCode: text("product_code"),
    /** Matched (case-insensitive substring) when the code is missing or unknown. */
    descriptionMatch: text("description_match"),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id),
    widthFt: feet("width_ft").notNull(),
    lengthFt: feet("length_ft").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("supplier_products_code_unique").on(t.supplierId, t.productCode)],
);

export const documentStatus = pgEnum("document_status", [
  "processing",
  "registered",
  "needs_review",
  "not_invoice",
  "duplicate",
  "failed",
]);

/** One attachment from a supplier email, archived in S3 and read by Claude. */
export const supplierDocuments = pgTable(
  "supplier_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    account: text("account").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    sha256: text("sha256").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    emailFrom: text("email_from").notNull(),
    emailSubject: text("email_subject").notNull(),
    emailReceivedAt: timestamp("email_received_at", { withTimezone: true }).notNull(),
    s3Key: text("s3_key").notNull(),
    documentType: text("document_type"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date", { mode: "string" }),
    shipDate: date("ship_date", { mode: "string" }),
    /** Claude's reading of the document (DocumentExtraction). */
    extracted: jsonb("extracted"),
    status: documentStatus("status").notNull().default("processing"),
    reviewReason: text("review_reason"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("supplier_documents_message_file_unique").on(t.gmailMessageId, t.sha256),
    index("supplier_documents_status_idx").on(t.status),
    index("supplier_documents_invoice_idx").on(t.supplierId, t.invoiceNumber),
  ],
);
