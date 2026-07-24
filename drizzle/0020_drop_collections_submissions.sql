-- Drop the dormant per-collection submissions flag (dead plumbing in Core; no submit endpoint consumes it).
ALTER TABLE "collections" DROP COLUMN IF EXISTS "submissions";
