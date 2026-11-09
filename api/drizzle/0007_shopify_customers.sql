CREATE TABLE "customer_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "sale_source" NOT NULL,
	"external_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"first_name" text,
	"last_name" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_sync" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_status" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subtotal" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_total" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_charged" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_total" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_lines" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_address" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_address" jsonb;--> statement-breakpoint
ALTER TABLE "customer_links" ADD CONSTRAINT "customer_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_links_source_external_unique" ON "customer_links" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "customer_links_customer_idx" ON "customer_links" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_unique" ON "customers" USING btree ("email") WHERE "customers"."email" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");