CREATE TYPE "public"."adjustment_reason" AS ENUM('opening_balance', 'count_correction', 'sale', 'other');--> statement-breakpoint
CREATE TYPE "public"."piece_status" AS ENUM('cut', 'at_summit', 'in_stock');--> statement-breakpoint
CREATE TYPE "public"."sewn_by" AS ENUM('in_house', 'summit', 'not_sewn');--> statement-breakpoint
CREATE TABLE "cut_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roll_id" uuid NOT NULL,
	"cut_on" date NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text
);
--> statement-breakpoint
CREATE TABLE "cut_sizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"label" text NOT NULL,
	"width_ft" numeric(8, 2) NOT NULL,
	"cut_length_ft" numeric(8, 2) NOT NULL,
	"product_family" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cut_size_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"reason" "adjustment_reason" NOT NULL,
	"adjusted_on" date NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"requires_sewing" boolean DEFAULT true NOT NULL,
	"default_width_ft" numeric(8, 2),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pieces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cut_session_id" uuid NOT NULL,
	"roll_id" uuid NOT NULL,
	"cut_size_id" uuid NOT NULL,
	"cut_length_ft" numeric(8, 2) NOT NULL,
	"cut_on" date NOT NULL,
	"status" "piece_status" DEFAULT 'cut' NOT NULL,
	"sewn_by" "sewn_by",
	"sewn_on" date,
	"sew_batch_id" uuid,
	"summit_shipment_id" uuid,
	"summit_receipt_id" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rolls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" serial NOT NULL,
	"app_code" text GENERATED ALWAYS AS ('R-' || lpad(seq::text, 4, '0')) STORED NOT NULL,
	"supplier_roll_no" text,
	"supplier" text,
	"material_id" uuid NOT NULL,
	"width_ft" numeric(8, 2) NOT NULL,
	"length_ft" numeric(8, 2) NOT NULL,
	"received_on" date NOT NULL,
	"closed_on" date,
	"leftover_ft_measured" numeric(8, 2),
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sew_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sewn_on" date NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text
);
--> statement-breakpoint
CREATE TABLE "summit_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cut_size_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"received_on" date NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text
);
--> statement-breakpoint
CREATE TABLE "summit_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sent_on" date NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text
);
--> statement-breakpoint
ALTER TABLE "cut_sessions" ADD CONSTRAINT "cut_sessions_roll_id_rolls_id_fk" FOREIGN KEY ("roll_id") REFERENCES "public"."rolls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cut_sizes" ADD CONSTRAINT "cut_sizes_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_cut_size_id_cut_sizes_id_fk" FOREIGN KEY ("cut_size_id") REFERENCES "public"."cut_sizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_cut_session_id_cut_sessions_id_fk" FOREIGN KEY ("cut_session_id") REFERENCES "public"."cut_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_roll_id_rolls_id_fk" FOREIGN KEY ("roll_id") REFERENCES "public"."rolls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_cut_size_id_cut_sizes_id_fk" FOREIGN KEY ("cut_size_id") REFERENCES "public"."cut_sizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_sew_batch_id_sew_batches_id_fk" FOREIGN KEY ("sew_batch_id") REFERENCES "public"."sew_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_summit_shipment_id_summit_shipments_id_fk" FOREIGN KEY ("summit_shipment_id") REFERENCES "public"."summit_shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_summit_receipt_id_summit_receipts_id_fk" FOREIGN KEY ("summit_receipt_id") REFERENCES "public"."summit_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summit_receipts" ADD CONSTRAINT "summit_receipts_cut_size_id_cut_sizes_id_fk" FOREIGN KEY ("cut_size_id") REFERENCES "public"."cut_sizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cut_sizes_material_label_unique" ON "cut_sizes" USING btree ("material_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "materials_name_unique" ON "materials" USING btree ("name");--> statement-breakpoint
CREATE INDEX "pieces_roll_idx" ON "pieces" USING btree ("roll_id");--> statement-breakpoint
CREATE INDEX "pieces_size_status_idx" ON "pieces" USING btree ("cut_size_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rolls_app_code_unique" ON "rolls" USING btree ("app_code");