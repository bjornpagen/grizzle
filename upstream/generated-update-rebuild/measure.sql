-- Each statement kind that reaches ExecComputeStoredGenerated, at :n1, :n2 and :n3 rows: its ExecutorState, read by a
-- statement-level AFTER trigger before ExecutorEnd (pg_backend_memory_contexts here, pg_log_backend_memory_contexts in
-- the server log, as "level: N; ExecutorState: <bytes> total in <n> blocks" after each "gen-probe" line), and its time.
-- Run with: psql -X -v n1=10000 -v n2=20000 -v n3=40000 -f measure.sql, as a superuser. It creates and drops the schema
-- gen, and includes measure-size.sql once per size.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS gen CASCADE;
CREATE SCHEMA gen;
SET search_path = gen;
SELECT format('CREATE TABLE t (a int PRIMARY KEY, b int NOT NULL, g int GENERATED ALWAYS AS (CASE WHEN a IN (%s) THEN 1 ELSE 0 END) STORED)',
  string_agg(i::text, ', ')) FROM generate_series(0, 999) AS i \gexec
SELECT format('CREATE TABLE tp (a int NOT NULL, b int NOT NULL, g int GENERATED ALWAYS AS (CASE WHEN a IN (%s) THEN 1 ELSE 0 END) STORED) PARTITION BY HASH (a)',
  string_agg(i::text, ', ')) FROM generate_series(0, 999) AS i \gexec
CREATE TABLE tp_0 PARTITION OF tp FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE tp_1 PARTITION OF tp FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE tp_2 PARTITION OF tp FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE tp_3 PARTITION OF tp FOR VALUES WITH (MODULUS 4, REMAINDER 3);
SELECT format('CREATE TABLE tt (a int PRIMARY KEY, b int NOT NULL, g int GENERATED ALWAYS AS (CASE WHEN a IN (%s) THEN 1 ELSE 0 END) STORED)',
  string_agg(i::text, ', ')) FROM generate_series(0, 999) AS i \gexec
CREATE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.b := NEW.b + 1; RETURN NEW; END $$;
CREATE TRIGGER bump BEFORE UPDATE ON tt FOR EACH ROW EXECUTE FUNCTION bump();

CREATE TABLE src (a int NOT NULL, b int NOT NULL);
CREATE TABLE probed (kind text, rows bigint, executor_state_bytes bigint);
CREATE FUNCTION probe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO n;
  RAISE LOG 'gen-probe kind=% rows=%', current_setting('gen.kind'), n;
  PERFORM pg_log_backend_memory_contexts(pg_backend_pid());
  INSERT INTO gen.probed
  SELECT current_setting('gen.kind'), n, max(total_bytes) FROM pg_backend_memory_contexts WHERE name = 'ExecutorState';
  RETURN NULL;
END $$;
CREATE TRIGGER probe_i AFTER INSERT ON t FOR EACH STATEMENT EXECUTE FUNCTION probe();
CREATE TRIGGER probe_u AFTER UPDATE ON t FOR EACH STATEMENT EXECUTE FUNCTION probe();
CREATE TRIGGER probe_u AFTER UPDATE ON tp FOR EACH STATEMENT EXECUTE FUNCTION probe();
CREATE TRIGGER probe_u AFTER UPDATE ON tt FOR EACH STATEMENT EXECUTE FUNCTION probe();

\set n :n1
\ir measure-size.sql
\set n :n2
\ir measure-size.sql
\set n :n3
\ir measure-size.sql

SELECT version();
SELECT kind, rows, max(executor_state_bytes) AS executor_state_bytes, max(executor_state_bytes) / rows AS bytes_per_row
FROM probed GROUP BY kind, rows ORDER BY kind, rows;
DROP SCHEMA gen CASCADE;
