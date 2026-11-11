ALTER TYPE "public"."stock_item_kind" ADD VALUE 'part';--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "parts_cost" numeric(14, 4) DEFAULT 0 NOT NULL;