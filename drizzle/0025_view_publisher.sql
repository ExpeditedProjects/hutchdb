-- Who published a view and when. Set when a view goes from unpublished to
-- published, cleared when it is unpublished (services/views.ts).
ALTER TABLE "views" ADD COLUMN "published_by" text;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_views_published_by" ON "views" USING btree ("published_by") WHERE "views"."published_by" IS NOT NULL;--> statement-breakpoint
-- Backfill views published now: published when last changed, by the owner
-- of a personal org (team orgs stay NULL; no record says which admin did it).
UPDATE "views" SET "published_at" = COALESCE("updated_at", now()) WHERE "published";--> statement-breakpoint
-- Cloud shares this file but marks a personal org with
-- organizations.personal_for_user_id; Core has a `personal` flag and the
-- owner as the org's admin member. PL/pgSQL plans a statement only when it
-- runs, so the branch for the other schema is never checked.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'organizations' AND column_name = 'personal_for_user_id'
  ) THEN
    UPDATE "views" v SET "published_by" = o."personal_for_user_id"
    FROM "collections" c JOIN "organizations" o ON o."id" = c."organization_id"
    WHERE v."published" AND c."id" = v."collection_id" AND o."personal_for_user_id" IS NOT NULL;
  ELSE
    UPDATE "views" v SET "published_by" = (
      SELECT m."user_id" FROM "organization_members" m
      WHERE m."organization_id" = o."id" AND m."role" = 'admin'
      ORDER BY m."created_at", m."user_id" LIMIT 1
    )
    FROM "collections" c JOIN "organizations" o ON o."id" = c."organization_id"
    WHERE v."published" AND c."id" = v."collection_id" AND o."personal";
  END IF;
END $$;
