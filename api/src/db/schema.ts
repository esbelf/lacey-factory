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
/** Dollars with 4 decimals; do math with @lacey-factory/shared/money. */
const money = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });

export const pieceStatus = pgEnum("piece_status", ["cut", "at_summit", "in_stock", "sold"]);
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
    // Default for new sizes of this material. Each cut size has its own
    // setting (cut_sizes.requires_sewing), which is what cutting uses.
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
    // false: cut pieces go straight to inventory (geogrid, SandMat on N06).
    requiresSewing: boolean("requires_sewing").notNull().default(true),
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
    /**
     * What the whole roll cost us, with its share of the invoice freight.
     * A piece's fabric cost is its cut length × cost ÷ lengthFt. Null = not known yet.
     */
    cost: money("cost"),
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
    /** Set when the piece went out with a sale (status "sold"). */
    saleId: uuid("sale_id").references(() => sales.id),
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
  /** Set on the "sale" rows a sale adds when it needs more than the in-stock pieces. */
  saleId: uuid("sale_id").references(() => sales.id),
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
    /** Our own SKU, e.g. "LM 24" (Amazon SKUs are linked in channel_skus). */
    sku: text("sku"),
    /** Packed weight with its box, in pounds. */
    shipWeightLb: numeric("ship_weight_lb", { precision: 7, scale: 2, mode: "number" }),
    /** Sewing cost per product when its pieces were sewn in-house / at Summit. */
    sewCostInHouse: money("sew_cost_in_house"),
    sewCostSummit: money("sew_cost_summit"),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("products_name_unique").on(t.name), uniqueIndex("products_sku_unique").on(t.sku)],
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
export const supplierKind = pgEnum("supplier_kind", ["rolls", "steel", "boxes"]);

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
    invoiceTotal: money("invoice_total"),
    /** Freight lines on the invoice (steel: spread over the lines as landed cost). */
    shippingCost: money("shipping_cost"),
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

// ───────────── Steel ─────────────

/** What a stocked-by-the-piece item is: a steel pole, a shipping box, or a part (stakes, zip ties, clips). */
export const stockItemKind = pgEnum("stock_item_kind", ["steel", "box", "part"]);

/**
 * Items we stock by the piece at FIFO cost: steel, shipping boxes and parts (`kind`).
 * Both use steel_lots / steel_usage / product_steel the same way.
 */
export const steelItems = pgTable(
  "steel_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(), // e.g. 1-1/4" × 10' galvanized pole, or LAKEMAT BOX
    kind: stockItemKind("kind").notNull().default("steel"),
    /** Box outside size in inches (boxes only). */
    lengthIn: numeric("length_in", { precision: 6, scale: 2, mode: "number" }),
    widthIn: numeric("width_in", { precision: 6, scale: 2, mode: "number" }),
    heightIn: numeric("height_in", { precision: 6, scale: 2, mode: "number" }),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    /** Slack low-stock alert when on hand is at or below this; null = no alert. */
    reorderLevel: integer("reorder_level"),
    /** When the low-stock alert went out; cleared once back above the level. */
    lowAlertedAt: timestamp("low_alerted_at", { withTimezone: true }),
    /** Michigan date of the last low-stock alert or Monday reminder (one per week). */
    lowRemindedOn: date("low_reminded_on", { mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("steel_items_name_unique").on(t.name)],
);

/** How a steel or box supplier's invoice lines map to our steel items (poles or boxes, matching the supplier's kind). */
export const supplierSteelProducts = pgTable(
  "supplier_steel_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    productCode: text("product_code"),
    descriptionMatch: text("description_match"),
    steelItemId: uuid("steel_item_id")
      .notNull()
      .references(() => steelItems.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("supplier_steel_products_code_unique").on(t.supplierId, t.productCode)],
);

/** The steel half of a product's recipe: e.g. MuckMat XL uses 4 × 10' poles. */
export const productSteel = pgTable(
  "product_steel",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    steelItemId: uuid("steel_item_id")
      .notNull()
      .references(() => steelItems.id),
    qty: integer("qty").notNull(),
  },
  (t) => [uniqueIndex("product_steel_unique").on(t.productId, t.steelItemId)],
);

export const steelLotSource = pgEnum("steel_lot_source", ["invoice", "opening_balance", "count_correction"]);

/**
 * A batch of poles at one cost (FIFO layer): one per invoice line, or a manual
 * opening balance / count correction. Sales use the oldest lots first.
 */
export const steelLots = pgTable(
  "steel_lots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    steelItemId: uuid("steel_item_id")
      .notNull()
      .references(() => steelItems.id),
    source: steelLotSource("source").notNull(),
    sourceDocumentId: uuid("source_document_id").references(() => supplierDocuments.id),
    invoiceNumber: text("invoice_number"),
    receivedOn: date("received_on", { mode: "string" }).notNull(),
    qty: integer("qty").notNull(),
    qtyRemaining: integer("qty_remaining").notNull(),
    /** Invoice rate per pole. */
    unitCost: money("unit_cost").notNull(),
    /** This line's share of the invoice freight, per pole. */
    freightPerUnit: money("freight_per_unit").notNull().default(0),
    /** unitCost + freightPerUnit: what a pole costs us, used for COGS. */
    landedUnitCost: money("landed_unit_cost").notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("steel_lots_item_idx").on(t.steelItemId, t.receivedOn)],
);

export const saleSource = pgEnum("sale_source", ["manual", "shopify", "amazon", "api"]);

/**
 * A product sale. Recording one takes the product's steel (oldest lots first)
 * and fabric pieces (oldest first) out of inventory. Undo is a soft void.
 */
export const sales = pgTable(
  "sales",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    qty: integer("qty").notNull(),
    soldOn: date("sold_on", { mode: "string" }).notNull(),
    source: saleSource("source").notNull(),
    /** Order id from the sales channel; the same order sent twice is recorded once. */
    externalRef: text("external_ref"),
    /** Steel cost of goods sold (FIFO landed cost). */
    steelCost: money("steel_cost").notNull().default(0),
    /** Shipping box cost (FIFO landed cost). */
    boxCost: money("box_cost").notNull().default(0),
    /** Stakes, zip ties and clips cost (FIFO, entered by hand). */
    partsCost: money("parts_cost").notNull().default(0),
    /** Fabric cost: each piece's share of its roll's price (oldest pieces first). */
    fabricCost: money("fabric_cost").notNull().default(0),
    /** True when a piece's roll has no price yet (or none to estimate from); filled in when one is set. */
    fabricCostMissing: boolean("fabric_cost_missing").notNull().default(false),
    /** Sewing cost at the product's rates when it sold, by who sewed its pieces. */
    sewingCost: money("sewing_cost").notNull().default(0),
    /** True when the product had no sewing rate for how it was sewn. */
    sewingCostMissing: boolean("sewing_cost_missing").notNull().default(false),
    /** True while some of its steel wasn't in stock; cleared when a delivery fills it in. */
    short: boolean("short").notNull().default(false),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
  },
  (t) => [uniqueIndex("sales_source_ref_unique").on(t.source, t.externalRef), index("sales_sold_on_idx").on(t.soldOn)],
);

export const steelUsageReason = pgEnum("steel_usage_reason", ["sale", "count_correction"]);

/**
 * Poles taken out of stock, by lot. A row with no lot means we ran short; the
 * next lot received for that item fills it in (and fixes the sale's cost).
 */
export const steelUsage = pgTable(
  "steel_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    steelItemId: uuid("steel_item_id")
      .notNull()
      .references(() => steelItems.id),
    lotId: uuid("lot_id").references(() => steelLots.id),
    qty: integer("qty").notNull(),
    landedUnitCost: money("landed_unit_cost").notNull(),
    reason: steelUsageReason("reason").notNull(),
    saleId: uuid("sale_id").references(() => sales.id),
    usedOn: date("used_on", { mode: "string" }).notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
  },
  (t) => [index("steel_usage_item_idx").on(t.steelItemId), index("steel_usage_sale_idx").on(t.saleId)],
);

// ── Sales-channel orders (Amazon and Shopify) ──

/**
 * A person who bought from us. One row per customer however many orders they
 * place: orders find their customer by channel customer id, then by email.
 * Order count and spend are derived from `orders`.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Lowercased and trimmed. */
    email: text("email"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("customers_email_unique").on(t.email).where(sql`${t.email} is not null`)],
);

/** A channel's own id for a customer (Shopify customer GID) → our customer. */
export const customerLinks = pgTable(
  "customer_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: saleSource("source").notNull(),
    externalId: text("external_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("customer_links_source_external_unique").on(t.source, t.externalId), index("customer_links_customer_idx").on(t.customerId)],
);

/** A postal address as the channel sent it (Shopify's field names). */
export type Address = {
  name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  provinceCode: string | null;
  zip: string | null;
  country: string | null;
  countryCode: string | null;
  phone: string | null;
};

/** One tax charged on an order, e.g. "MI State Tax" at 6%, or "HST" at 13%. */
export type TaxLine = { title: string; rate: number | null; amount: number };

export const orderItemState = pgEnum("order_item_state", [
  "waiting", // order not paid yet (Amazon "Pending"): nothing taken from stock
  "recorded", // a sale was recorded and its steel and fabric taken
  "needs_mapping", // the SKU isn't linked to a product yet
  "needs_recipe", // the product has no steel/fabric recipe yet
  "canceled", // order canceled; any sale was undone
  "ignored", // SKU marked "not a factory product"
]);

/** An order from a sales channel, kept as the channel sent it (`raw`) plus the fields we filter on. */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: saleSource("source").notNull(),
    /** The channel's order number, e.g. Amazon's 112-1234567-1234567. */
    externalId: text("external_id").notNull(),
    marketplaceId: text("marketplace_id"),
    /** Short market code: US, CA. */
    marketplace: text("marketplace"),
    salesChannel: text("sales_channel"),
    status: text("status").notNull(),
    fulfillmentChannel: text("fulfillment_channel"),
    orderType: text("order_type"),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull(),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull(),
    earliestShipDate: timestamp("earliest_ship_date", { withTimezone: true }),
    latestShipDate: timestamp("latest_ship_date", { withTimezone: true }),
    latestDeliveryDate: timestamp("latest_delivery_date", { withTimezone: true }),
    currency: text("currency"),
    orderTotal: money("order_total"),
    itemsShipped: integer("items_shipped"),
    itemsUnshipped: integer("items_unshipped"),
    paymentMethod: text("payment_method"),
    shipServiceLevel: text("ship_service_level"),
    isPrime: boolean("is_prime").notNull().default(false),
    isBusiness: boolean("is_business").notNull().default(false),
    isReplacement: boolean("is_replacement").notNull().default(false),
    shipCity: text("ship_city"),
    shipState: text("ship_state"),
    shipPostalCode: text("ship_postal_code"),
    shipCountry: text("ship_country"),
    /** Who bought it (Shopify; Amazon doesn't share buyers). */
    customerId: uuid("customer_id").references(() => customers.id),
    email: text("email"),
    phone: text("phone"),
    /** The number the customer sees, e.g. Shopify's "#1001". */
    orderName: text("order_name"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    fulfillmentStatus: text("fulfillment_status"),
    /** Order money in its currency: items before discounts, discounts, shipping the customer paid, tax. */
    subtotal: money("subtotal"),
    discountTotal: money("discount_total"),
    shippingCharged: money("shipping_charged"),
    taxTotal: money("tax_total"),
    taxLines: jsonb("tax_lines").$type<TaxLine[]>(),
    shippingAddress: jsonb("shipping_address").$type<Address>(),
    billingAddress: jsonb("billing_address").$type<Address>(),
    /** Everything the channel sent for the order. */
    raw: jsonb("raw").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("orders_source_external_unique").on(t.source, t.externalId),
    index("orders_purchased_idx").on(t.purchasedAt),
    index("orders_customer_idx").on(t.customerId),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    externalItemId: text("external_item_id").notNull(),
    sku: text("sku"),
    asin: text("asin"),
    title: text("title"),
    qtyOrdered: integer("qty_ordered").notNull(),
    qtyShipped: integer("qty_shipped").notNull().default(0),
    /** In the order's currency. */
    itemPrice: money("item_price"),
    itemTax: money("item_tax"),
    shippingPrice: money("shipping_price"),
    shippingTax: money("shipping_tax"),
    promotionDiscount: money("promotion_discount"),
    raw: jsonb("raw").notNull(),
    state: orderItemState("state").notNull().default("waiting"),
    /** Why it isn't recorded (missing mapping or recipe). */
    problem: text("problem"),
    productId: uuid("product_id").references(() => products.id),
    saleId: uuid("sale_id").references(() => sales.id),
  },
  (t) => [
    uniqueIndex("order_items_external_unique").on(t.orderId, t.externalItemId),
    index("order_items_sku_idx").on(t.sku),
  ],
);

/** Which product a channel SKU is. No product = "not a factory product", ignored. */
export const channelSkus = pgTable(
  "channel_skus",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: saleSource("source").notNull(),
    sku: text("sku").notNull(),
    productId: uuid("product_id").references(() => products.id),
    /** Products per unit sold (a 2-pack is 2). */
    qtyPerUnit: integer("qty_per_unit").notNull().default(1),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("channel_skus_source_sku_unique").on(t.source, t.sku)],
);

/** Polling cursor and health, one row per channel. */
export const channelSync = pgTable("channel_sync", {
  source: saleSource("source").primaryKey(),
  /** Orders updated up to here have been processed. */
  cursor: timestamp("cursor", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastError: text("last_error"),
  ordersSeen: integer("orders_seen").notNull().default(0),
  /** Last webhook from the channel (Shopify). */
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
});
