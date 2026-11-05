CREATE TYPE "public"."order_item_state" AS ENUM('waiting', 'recorded', 'needs_mapping', 'needs_recipe', 'canceled', 'ignored');--> statement-breakpoint
CREATE TABLE "channel_skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "sale_source" NOT NULL,
	"sku" text NOT NULL,
	"product_id" uuid,
	"qty_per_unit" integer DEFAULT 1 NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_sync" (
	"source" "sale_source" PRIMARY KEY NOT NULL,
	"cursor" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"orders_seen" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"external_item_id" text NOT NULL,
	"sku" text,
	"asin" text,
	"title" text,
	"qty_ordered" integer NOT NULL,
	"qty_shipped" integer DEFAULT 0 NOT NULL,
	"item_price" numeric(14, 4),
	"item_tax" numeric(14, 4),
	"shipping_price" numeric(14, 4),
	"shipping_tax" numeric(14, 4),
	"promotion_discount" numeric(14, 4),
	"raw" jsonb NOT NULL,
	"state" "order_item_state" DEFAULT 'waiting' NOT NULL,
	"problem" text,
	"product_id" uuid,
	"sale_id" uuid
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "sale_source" NOT NULL,
	"external_id" text NOT NULL,
	"marketplace_id" text,
	"marketplace" text,
	"sales_channel" text,
	"status" text NOT NULL,
	"fulfillment_channel" text,
	"order_type" text,
	"purchased_at" timestamp with time zone NOT NULL,
	"last_updated_at" timestamp with time zone NOT NULL,
	"earliest_ship_date" timestamp with time zone,
	"latest_ship_date" timestamp with time zone,
	"latest_delivery_date" timestamp with time zone,
	"currency" text,
	"order_total" numeric(14, 4),
	"items_shipped" integer,
	"items_unshipped" integer,
	"payment_method" text,
	"ship_service_level" text,
	"is_prime" boolean DEFAULT false NOT NULL,
	"is_business" boolean DEFAULT false NOT NULL,
	"is_replacement" boolean DEFAULT false NOT NULL,
	"ship_city" text,
	"ship_state" text,
	"ship_postal_code" text,
	"ship_country" text,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_skus" ADD CONSTRAINT "channel_skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_skus_source_sku_unique" ON "channel_skus" USING btree ("source","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_external_unique" ON "order_items" USING btree ("order_id","external_item_id");--> statement-breakpoint
CREATE INDEX "order_items_sku_idx" ON "order_items" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_source_external_unique" ON "orders" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "orders_purchased_idx" ON "orders" USING btree ("purchased_at");