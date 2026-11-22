-- ExecUpdateLockMode's key-column bitmap, once per row, in ExecutorState.
-- psql -X -v n=100000 -f repro.sql
\set ON_ERROR_STOP on
SET client_min_messages = warning;
DROP TABLE IF EXISTS leak_probe, leak_t, leak_u, leak_c;
CREATE TABLE leak_probe (kind text, n int, executor_state bigint);
CREATE FUNCTION pg_temp.probe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO leak_probe
  SELECT TG_ARGV[0], TG_ARGV[1]::int, sum(total_bytes)
  FROM pg_backend_memory_contexts WHERE name = 'ExecutorState';
  RETURN NULL;
END $$;
CREATE FUNCTION pg_temp.keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

-- UPDATE with an enabled BEFORE ROW UPDATE trigger: ExecBRUpdateTriggers -> ExecUpdateLockMode, per row
CREATE TABLE leak_t (id int PRIMARY KEY, a int NOT NULL DEFAULT 0);
INSERT INTO leak_t (id) SELECT generate_series(1, :n);
CREATE TRIGGER keep BEFORE UPDATE ON leak_t FOR EACH ROW EXECUTE FUNCTION pg_temp.keep();
CREATE TRIGGER probe AFTER UPDATE ON leak_t FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.probe('update, BEFORE ROW trigger', :'n');
UPDATE leak_t SET a = 1;

-- INSERT ... ON CONFLICT DO UPDATE, no trigger but the probe: ExecOnConflictUpdate -> ExecUpdateLockMode, per row
CREATE TABLE leak_u (id int PRIMARY KEY, a int NOT NULL DEFAULT 0);
INSERT INTO leak_u (id) SELECT generate_series(1, :n);
CREATE TRIGGER probe AFTER UPDATE ON leak_u FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.probe('insert on conflict do update', :'n');
INSERT INTO leak_u (id) SELECT generate_series(1, :n) ON CONFLICT (id) DO UPDATE SET a = 1;

-- the control: a plain UPDATE, which never computes a lock mode
CREATE TABLE leak_c (id int PRIMARY KEY, a int NOT NULL DEFAULT 0);
INSERT INTO leak_c (id) SELECT generate_series(1, :n);
CREATE TRIGGER probe AFTER UPDATE ON leak_c FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.probe('update, no trigger (control)', :'n');
UPDATE leak_c SET a = 1;

SELECT kind, n, pg_size_pretty(executor_state) AS executor_state FROM leak_probe ORDER BY kind;
