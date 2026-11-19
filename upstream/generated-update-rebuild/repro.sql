-- An UPDATE that assigns no column any stored generated column reads rebuilds the table's generation expressions for
-- every row it updates, in the query's memory (ExecutorState), which nothing frees before the statement ends.
-- Run with: psql -X -f repro.sql (a superuser, or a role with pg_read_all_stats, for pg_backend_memory_contexts).
-- It creates and drops the schema gen_rebuild.
\set ON_ERROR_STOP on
\pset footer off
DROP SCHEMA IF EXISTS gen_rebuild CASCADE;
CREATE SCHEMA gen_rebuild;
SET search_path = gen_rebuild;

-- A table with one stored generated column over a, its expression of some size: a 1,000-element IN list.
SELECT format(
  'CREATE TABLE t (a int NOT NULL, b int NOT NULL, g int GENERATED ALWAYS AS (CASE WHEN a IN (%s) THEN 1 ELSE 0 END) STORED)',
  string_agg(i::text, ', ')
) FROM generate_series(0, 999) AS i \gexec

-- ExecutorState as each UPDATE statement ends: a statement-level AFTER trigger runs before ExecutorEnd frees it.
CREATE TABLE probed (statement text, rows bigint, executor_state_bytes bigint);
CREATE FUNCTION probe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gen_rebuild.probed
  SELECT current_setting('gen_rebuild.statement'), (SELECT count(*) FROM gen_rebuild.t), max(total_bytes)
  FROM pg_backend_memory_contexts WHERE name = 'ExecutorState';
  RETURN NULL;
END $$;
CREATE TRIGGER probe AFTER UPDATE ON t FOR EACH STATEMENT EXECUTE FUNCTION probe();

-- Each size: SET b, which g does not read, then SET a = a too, which it does.
\set n 2000
\ir repro-size.sql
\set n 8000
\ir repro-size.sql
\set n 32000
\ir repro-size.sql

SELECT version();
SELECT statement, rows, executor_state_bytes, executor_state_bytes / rows AS bytes_per_row FROM probed ORDER BY statement, rows;
DROP SCHEMA gen_rebuild CASCADE;
