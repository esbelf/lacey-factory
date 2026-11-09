ALTER TABLE "products" ADD COLUMN "sew_cost_in_house" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sew_cost_summit" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "rolls" ADD COLUMN "cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "fabric_cost" numeric(14, 4) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "fabric_cost_missing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "sewing_cost" numeric(14, 4) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "sewing_cost_missing" boolean DEFAULT false NOT NULL;