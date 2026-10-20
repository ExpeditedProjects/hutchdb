-- Every collection keeps its rows in its own hc_<id> table, so the layout
-- pointer 0021 added is gone. Moving existing rows out of `records` (and
-- dropping it) is `npm run storage:cutover`, never a migration, so running
-- migrations can never destroy data before the copy has been verified.
ALTER TABLE "collections" DROP COLUMN IF EXISTS "layout";
