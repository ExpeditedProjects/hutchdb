-- Bookkeeping for the shared -> table storage migration (src/lib/storage/
-- migrate.ts, `npm run storage:migrate`). Additive only; nothing reads or
-- changes `records` here.
--   migration_state:      NULL (never migrated) | creating | copying |
--                         verifying | swapped | cleaned | failed | rolled_back
--   migration_swapped_at: when layout flipped to 'table'; starts the
--                         retention window before `clean` may delete the
--                         collection's rows from `records`
--   migration_report:     what the job did (copy timings, write pause,
--                         projections/unwinds inference created, rollback
--                         and clean results)
--   migration_error:      why the last attempt stopped (verify mismatch...)
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "migration_state" text;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "migration_swapped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "migration_report" jsonb;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "migration_error" text;
