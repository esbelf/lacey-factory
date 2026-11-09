ALTER TABLE "cut_sizes" ADD COLUMN "requires_sewing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Each size starts with its material's setting.
UPDATE "cut_sizes" SET "requires_sewing" = "materials"."requires_sewing" FROM "materials" WHERE "materials"."id" = "cut_sizes"."material_id";--> statement-breakpoint
-- SandMat sizes on TerraTex N06 aren't sewn.
UPDATE "cut_sizes" SET "requires_sewing" = false FROM "materials" WHERE "materials"."id" = "cut_sizes"."material_id" AND "materials"."name" = 'TerraTex N06' AND "cut_sizes"."product_family" LIKE 'SandMat%';--> statement-breakpoint
-- Pieces of unsewn sizes that were waiting to be sewn go to inventory.
UPDATE "pieces" SET "status" = 'in_stock', "sewn_by" = 'not_sewn' FROM "cut_sizes" WHERE "cut_sizes"."id" = "pieces"."cut_size_id" AND "cut_sizes"."requires_sewing" = false AND "pieces"."status" = 'cut' AND "pieces"."voided_at" IS NULL;
