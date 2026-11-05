CREATE TYPE "public"."sale_source" AS ENUM('manual', 'shopify', 'amazon', 'api');--> statement-breakpoint
CREATE TYPE "public"."steel_lot_source" AS ENUM('invoice', 'opening_balance', 'count_correction');--> statement-breakpoint
CREATE TYPE "public"."steel_usage_reason" AS ENUM('sale', 'count_correction');--> statement-breakpoint
ALTER TYPE "public"."piece_status" ADD VALUE 'sold';--> statement-breakpoint
ALTER TYPE "public"."supplier_kind" ADD VALUE 'steel';--> statement-breakpoint
CREATE TABLE "product_steel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"steel_item_id" uuid NOT NULL,
	"qty" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"sold_on" date NOT NULL,
	"source" "sale_source" NOT NULL,
	"external_ref" text,
	"steel_cost" numeric(14, 4) DEFAULT 0 NOT NULL,
	"short" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text
);
--> statement-breakpoint
CREATE TABLE "steel_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steel_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"steel_item_id" uuid NOT NULL,
	"source" "steel_lot_source" NOT NULL,
	"source_document_id" uuid,
	"invoice_number" text,
	"received_on" date NOT NULL,
	"qty" integer NOT NULL,
	"qty_remaining" integer NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"freight_per_unit" numeric(14, 4) DEFAULT 0 NOT NULL,
	"landed_unit_cost" numeric(14, 4) NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steel_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"steel_item_id" uuid NOT NULL,
	"lot_id" uuid,
	"qty" integer NOT NULL,
	"landed_unit_cost" numeric(14, 4) NOT NULL,
	"reason" "steel_usage_reason" NOT NULL,
	"sale_id" uuid,
	"used_on" date NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_steel_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"product_code" text,
	"description_match" text,
	"steel_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD COLUMN "sale_id" uuid;--> statement-breakpoint
ALTER TABLE "pieces" ADD COLUMN "sale_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_documents" ADD COLUMN "invoice_total" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "supplier_documents" ADD COLUMN "shipping_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "product_steel" ADD CONSTRAINT "product_steel_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_steel" ADD CONSTRAINT "product_steel_steel_item_id_steel_items_id_fk" FOREIGN KEY ("steel_item_id") REFERENCES "public"."steel_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steel_lots" ADD CONSTRAINT "steel_lots_steel_item_id_steel_items_id_fk" FOREIGN KEY ("steel_item_id") REFERENCES "public"."steel_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steel_lots" ADD CONSTRAINT "steel_lots_source_document_id_supplier_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."supplier_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steel_usage" ADD CONSTRAINT "steel_usage_steel_item_id_steel_items_id_fk" FOREIGN KEY ("steel_item_id") REFERENCES "public"."steel_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steel_usage" ADD CONSTRAINT "steel_usage_lot_id_steel_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."steel_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steel_usage" ADD CONSTRAINT "steel_usage_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_steel_products" ADD CONSTRAINT "supplier_steel_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_steel_products" ADD CONSTRAINT "supplier_steel_products_steel_item_id_steel_items_id_fk" FOREIGN KEY ("steel_item_id") REFERENCES "public"."steel_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_steel_unique" ON "product_steel" USING btree ("product_id","steel_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_source_ref_unique" ON "sales" USING btree ("source","external_ref");--> statement-breakpoint
CREATE INDEX "sales_sold_on_idx" ON "sales" USING btree ("sold_on");--> statement-breakpoint
CREATE UNIQUE INDEX "steel_items_name_unique" ON "steel_items" USING btree ("name");--> statement-breakpoint
CREATE INDEX "steel_lots_item_idx" ON "steel_lots" USING btree ("steel_item_id","received_on");--> statement-breakpoint
CREATE INDEX "steel_usage_item_idx" ON "steel_usage" USING btree ("steel_item_id");--> statement-breakpoint
CREATE INDEX "steel_usage_sale_idx" ON "steel_usage" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_steel_products_code_unique" ON "supplier_steel_products" USING btree ("supplier_id","product_code");--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;