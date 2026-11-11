ALTER TABLE "steel_items" ADD COLUMN "reorder_level" integer;--> statement-breakpoint
ALTER TABLE "steel_items" ADD COLUMN "low_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "steel_items" ADD COLUMN "low_reminded_on" date;