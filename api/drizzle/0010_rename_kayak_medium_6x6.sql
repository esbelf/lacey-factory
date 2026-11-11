-- Kayak Mat Medium is 6x6, not 6x5. Rename in place so its sales and SKU links stay.
UPDATE "products" SET "name" = 'Kayak Mat Medium 6x6'
WHERE "name" = 'Kayak Mat Medium 6x5'
  AND NOT EXISTS (SELECT 1 FROM "products" WHERE "name" = 'Kayak Mat Medium 6x6');
