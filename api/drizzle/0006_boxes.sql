CREATE TYPE "public"."stock_item_kind" AS ENUM('steel', 'box');--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "ship_weight_lb" numeric(7, 2);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "box_cost" numeric(14, 4) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "steel_items" ADD COLUMN "kind" "stock_item_kind" DEFAULT 'steel' NOT NULL;--> statement-breakpoint
ALTER TABLE "steel_items" ADD COLUMN "length_in" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "steel_items" ADD COLUMN "width_in" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "steel_items" ADD COLUMN "height_in" numeric(6, 2);--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_unique" ON "products" USING btree ("sku");