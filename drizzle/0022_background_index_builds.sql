-- Background builds (src/lib/storage/builder.ts). Writes no longer run
-- projection or unwind DDL; they queue it in collections.storage and the
-- builder runs it outside the request: CREATE INDEX CONCURRENTLY for
-- expression projections and the search index (no table rewrite, no
-- ACCESS EXCLUSIVE lock), and, for an unwind, the child table and its sync
-- triggers first, then this batched backfill.
--
-- Backfill the child rows of unwind `child` for the parent rows with
-- lo < id <= hi (and, when `only_ids` is given, id in `only_ids`). The rows are
-- locked FOR SHARE SKIP LOCKED, so the builder never waits on a writer's
-- row lock (and can't deadlock with one): a concurrent UPDATE of a locked
-- row waits for this statement, then its trigger resyncs the row. Each
-- locked row's child rows are deleted and inserted again from its current
-- version. Rows inserted meanwhile are not touched (their insert trigger
-- filled them). Returns the ids in range it could not lock; the builder
-- calls again with those as `only_ids` until none are left.
CREATE OR REPLACE FUNCTION hc_unwind_backfill_rows(collection_id int, parent text, child text, lo int, hi int, only_ids int[]) RETURNS int[]
LANGUAGE plpgsql AS $$
DECLARE
  ids int[];
  skipped int[];
  fill text := hc_unwind_fill_sql(collection_id, child, format('(SELECT p.* FROM %I p WHERE p.id = ANY($1))', parent));
BEGIN
  IF fill IS NULL THEN
    RAISE EXCEPTION 'unwind % is not registered for collection %', child, collection_id;
  END IF;
  EXECUTE format(
    'SELECT coalesce(array_agg(id ORDER BY id), ''{}'') FROM ('
    || 'SELECT id FROM %I WHERE id > $1 AND id <= $2 AND ($3 IS NULL OR id = ANY($3)) FOR SHARE SKIP LOCKED) l', parent)
    INTO ids USING lo, hi, only_ids;
  IF cardinality(ids) > 0 THEN
    EXECUTE format('DELETE FROM %I WHERE parent_id = ANY($1)', child) USING ids;
    EXECUTE fill USING ids;
  END IF;
  EXECUTE format(
    'SELECT coalesce(array_agg(id ORDER BY id), ''{}'') FROM %I '
    || 'WHERE id > $1 AND id <= $2 AND ($3 IS NULL OR id = ANY($3)) AND id <> ALL($4)', parent)
    INTO skipped USING lo, hi, only_ids, ids;
  RETURN skipped;
END $$;
