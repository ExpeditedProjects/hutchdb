-- Per-view publishing: a published collection's public page shows only the
-- views marked published, so auto-seeded and scratch views stay private.
ALTER TABLE "views" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Keep every page that is already live unchanged: publish all existing views
-- of collections that are published now.
UPDATE "views" SET "published" = true WHERE "collection_id" IN (SELECT "id" FROM "collections" WHERE "published" = true);
