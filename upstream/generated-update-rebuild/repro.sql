-- An UPDATE that assigns no column a stored generated column reads initializes the table's generation expressions
-- again for every row, in ExecutorState.  Run with psql -X as a superuser (for pg_backend_memory_contexts).
\set ON_ERROR_STOP on
SELECT format('CREATE TABLE t (a int, b int, g int GENERATED ALWAYS AS '
              '(CASE WHEN a IN (%s) THEN 1 ELSE 0 END) STORED)',
              string_agg(i::text, ', '))
FROM generate_series(0, 999) AS i \gexec
INSERT INTO t (a, b) SELECT i, i FROM generate_series(1, 40000) AS i;
-- A statement-level AFTER trigger runs before ExecutorEnd, so it sees the UPDATE's ExecutorState.
CREATE FUNCTION probe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'ExecutorState: % bytes', (SELECT max(total_bytes)
    FROM pg_backend_memory_contexts WHERE name = 'ExecutorState');
  RETURN NULL;
END $$;
CREATE TRIGGER probe AFTER UPDATE ON t FOR EACH STATEMENT EXECUTE FUNCTION probe();
\timing on
UPDATE t SET b = b + 1;         -- g doesn't read b
UPDATE t SET a = a, b = b + 1;  -- g reads a
\timing off
DROP TABLE t;
DROP FUNCTION probe();
