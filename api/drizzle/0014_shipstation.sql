CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label_id" text NOT NULL,
	"shipment_id" text,
	"order_id" uuid,
	"order_source_code" text,
	"external_order_id" text,
	"shipment_number" text,
	"status" text NOT NULL,
	"carrier_code" text,
	"service_code" text,
	"tracking_number" text,
	"tracking_url" text,
	"ship_date" date,
	"shipped_at" timestamp with time zone,
	"cost" numeric(14, 4) NOT NULL,
	"currency" text,
	"voided_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_sync" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_label_unique" ON "shipments" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");