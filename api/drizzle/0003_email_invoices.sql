CREATE TYPE "public"."document_status" AS ENUM('processing', 'registered', 'needs_review', 'not_invoice', 'duplicate', 'failed');--> statement-breakpoint
CREATE TYPE "public"."email_account_status" AS ENUM('connected', 'needs_reauth', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."supplier_kind" AS ENUM('rolls');--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"refresh_token_enc" text,
	"status" "email_account_status" DEFAULT 'disconnected' NOT NULL,
	"history_id" text,
	"watch_expires_at" timestamp with time zone,
	"connected_by" text,
	"connected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"user_email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"account" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"sha256" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"email_from" text NOT NULL,
	"email_subject" text NOT NULL,
	"email_received_at" timestamp with time zone NOT NULL,
	"s3_key" text NOT NULL,
	"document_type" text,
	"invoice_number" text,
	"invoice_date" date,
	"ship_date" date,
	"extracted" jsonb,
	"status" "document_status" DEFAULT 'processing' NOT NULL,
	"review_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"product_code" text,
	"description_match" text,
	"material_id" uuid NOT NULL,
	"width_ft" numeric(8, 2) NOT NULL,
	"length_ft" numeric(8, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "supplier_kind" NOT NULL,
	"email_patterns" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rolls" ADD COLUMN "source_document_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_accounts_email_unique" ON "email_accounts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_documents_message_file_unique" ON "supplier_documents" USING btree ("gmail_message_id","sha256");--> statement-breakpoint
CREATE INDEX "supplier_documents_status_idx" ON "supplier_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "supplier_documents_invoice_idx" ON "supplier_documents" USING btree ("supplier_id","invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_products_code_unique" ON "supplier_products" USING btree ("supplier_id","product_code");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_unique" ON "suppliers" USING btree ("name");--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_source_document_id_supplier_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."supplier_documents"("id") ON DELETE no action ON UPDATE no action;