-- Per-collection storage (src/lib/storage). Every collection keeps its rows
-- in its own hc_<id> table; `storage` is the registry of projections and
-- unwinds that inference created on it. Moving rows out of the old
-- `records` table is `npm run storage:cutover`, never a migration.
ALTER TABLE "collections" ADD COLUMN "storage" jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
-- Guarded casts used by projection columns. Generated columns must never
-- throw (a bad value would reject the whole document), so overflow and
-- invalid dates become NULL instead of errors.
CREATE OR REPLACE FUNCTION hc_safe_float8(v jsonb) RETURNS float8
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  RETURN v::float8;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION hc_safe_date(v text) RETURNS date
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  RETURN v::date;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;
--> statement-breakpoint
-- SQL text of the guarded cast of JSON key `key` of expression `src` to the
-- projection type `kind`. `src` is a trusted expression written by code
-- ('data', 'e.val'); `key` is user data and goes through %L.
CREATE OR REPLACE FUNCTION hc_cast_expr(src text, key text, kind text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE kind
    WHEN 'number' THEN
      format('CASE WHEN jsonb_typeof(%s->%L) = ''number'' THEN hc_safe_float8(%s->%L) END', src, key, src, key)
    WHEN 'boolean' THEN
      format('CASE WHEN jsonb_typeof(%s->%L) = ''boolean'' THEN (%s->%L)::boolean END', src, key, src, key)
    WHEN 'date' THEN
      format('CASE WHEN jsonb_typeof(%s->%L) = ''string'' AND (%s->>%L) ~ ''^\d{4}-\d{2}-\d{2}$'' THEN hc_safe_date(%s->>%L) END', src, key, src, key, src, key)
    ELSE
      format('CASE WHEN jsonb_typeof(%s->%L) = ''string'' THEN %s->>%L END', src, key, src, key)
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION hc_pg_type(kind text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE kind WHEN 'number' THEN 'float8' WHEN 'boolean' THEN 'boolean' WHEN 'date' THEN 'date' ELSE 'text' END
$$;
--> statement-breakpoint
-- Add a stored generated projection column `col` on table `tbl` for JSON
-- key `key`. All arguments arrive as bound parameters from the app; the
-- identifiers are already sanitized there and are quoted again with %I.
CREATE OR REPLACE FUNCTION hc_add_projection(tbl text, col text, key text, kind text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I %s GENERATED ALWAYS AS (%s) STORED',
                 tbl, col, hc_pg_type(kind), hc_cast_expr('data', key, kind));
END $$;
--> statement-breakpoint
-- The same guarded cast for a value at a path below `src` (a nested object
-- scalar such as totals.veterans.points). `path` is user data and goes
-- through %L, then is cast back to text[] for the #> / #>> operators.
CREATE OR REPLACE FUNCTION hc_cast_path_expr(src text, path text[], kind text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE kind
    WHEN 'number' THEN
      format('CASE WHEN jsonb_typeof(%s #> %L::text[]) = ''number'' THEN hc_safe_float8(%s #> %L::text[]) END', src, path, src, path)
    WHEN 'boolean' THEN
      format('CASE WHEN jsonb_typeof(%s #> %L::text[]) = ''boolean'' THEN (%s #> %L::text[])::boolean END', src, path, src, path)
    WHEN 'date' THEN
      format('CASE WHEN jsonb_typeof(%s #> %L::text[]) = ''string'' AND (%s #>> %L::text[]) ~ ''^\d{4}-\d{2}-\d{2}$'' THEN hc_safe_date(%s #>> %L::text[]) END', src, path, src, path, src, path)
    ELSE
      format('CASE WHEN jsonb_typeof(%s #> %L::text[]) = ''string'' THEN %s #>> %L::text[] END', src, path, src, path)
  END
$$;
--> statement-breakpoint
-- Projection column for a nested object path. Same contract as
-- hc_add_projection: identifiers sanitized by the app and quoted again with
-- %I, the path quoted with %L inside hc_cast_path_expr.
CREATE OR REPLACE FUNCTION hc_add_path_projection(tbl text, col text, path text[], kind text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I %s GENERATED ALWAYS AS (%s) STORED',
                 tbl, col, hc_pg_type(kind), hc_cast_path_expr('data', path, kind));
END $$;
--> statement-breakpoint
-- Unique-key support: one stored generated jsonb column
-- uk_<n> per key field plus a partial unique index over them, so inserts can
-- use ON CONFLICT (uk_0, ...) WHERE deleted_at IS NULL without any user
-- string in the INSERT statement. Passing an empty array removes the key.
CREATE OR REPLACE FUNCTION hc_set_unique_key(tbl text, keys text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  i int;
  cols text := '';
  col record;
BEGIN
  EXECUTE format('DROP INDEX IF EXISTS %I', tbl || '_uk');
  FOR col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = tbl AND column_name LIKE 'uk\_%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS %I', tbl, col.column_name);
  END LOOP;
  IF keys IS NULL OR array_length(keys, 1) IS NULL THEN
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(keys, 1) LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN %I jsonb GENERATED ALWAYS AS (data->%L) STORED',
                   tbl, 'uk_' || (i - 1), keys[i]);
    cols := cols || CASE WHEN i > 1 THEN ', ' ELSE '' END || format('%I', 'uk_' || (i - 1));
  END LOOP;
  EXECUTE format('CREATE UNIQUE INDEX %I ON %I (%s) WHERE deleted_at IS NULL', tbl || '_uk', tbl, cols);
END $$;
--> statement-breakpoint
-- SQL text that rebuilds the child rows of unwind table `child` from the
-- parent rows in relation `src` (trusted: 'new_rows' inside the trigger, or
-- the parent table name for a backfill). The unwind's path and element
-- columns are read from the registry in collections.storage at run time, so
-- no user string is ever baked into DDL or a trigger definition.
CREATE OR REPLACE FUNCTION hc_unwind_fill_sql(collection_id int, child text, src text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  cfg jsonb;
  f jsonb;
  cols text := '';
  vals text := '';
BEGIN
  SELECT u INTO cfg
  FROM collections c, jsonb_array_elements(c.storage->'unwinds') u
  WHERE c.id = collection_id AND u->>'table' = child;
  IF cfg IS NULL THEN
    RETURN NULL;
  END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(cfg->'fields') LOOP
    cols := cols || format(', %I', f->>'column');
    vals := vals || ', ' || hc_cast_expr('e.val', f->>'field', f->>'type');
  END LOOP;
  RETURN format(
    'INSERT INTO %I (parent_id, idx%s) SELECT n.id, e.ord%s FROM %s n, '
    || 'jsonb_array_elements(CASE WHEN jsonb_typeof(n.data->%L) = ''array'' THEN n.data->%L ELSE ''[]''::jsonb END) '
    || 'WITH ORDINALITY e(val, ord)',
    child, cols, vals, src, cfg->>'path', cfg->>'path');
END $$;
--> statement-breakpoint
-- Statement-level trigger on a parent table: resyncs the child rows of one
-- unwind for every inserted row, and for every updated row whose data
-- changed. Args: collection id, child table name (sanitized by the app).
CREATE OR REPLACE FUNCTION hc_sync_unwind() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  child text := TG_ARGV[1];
  src text;
  stmt text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    src := '(SELECT n.* FROM new_rows n JOIN old_rows o ON o.id = n.id WHERE n.data IS DISTINCT FROM o.data)';
  ELSE
    src := 'new_rows';
  END IF;
  stmt := hc_unwind_fill_sql(TG_ARGV[0]::int, child, src);
  IF stmt IS NOT NULL THEN
    EXECUTE format('DELETE FROM %I d USING %s n WHERE d.parent_id = n.id', child, src);
    EXECUTE stmt;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Backfill an unwind's child rows from every existing parent row.
CREATE OR REPLACE FUNCTION hc_unwind_backfill(collection_id int, parent text, child text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  stmt text := hc_unwind_fill_sql(collection_id, child, format('%I', parent));
BEGIN
  IF stmt IS NULL THEN
    RAISE EXCEPTION 'unwind % is not registered for collection %', child, collection_id;
  END IF;
  EXECUTE format('DELETE FROM %I', child);
  EXECUTE stmt;
END $$;
