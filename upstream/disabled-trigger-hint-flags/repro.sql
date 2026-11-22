-- What a DISABLED BEFORE ROW UPDATE trigger costs an UPDATE, per row.
-- psql -X -v n=100000 -f repro.sql
\set ON_ERROR_STOP on
SET client_min_messages = warning;
DROP TABLE IF EXISTS dis_none, dis_disabled, dis_enabled, dis_result;
DROP FUNCTION IF EXISTS dis_counted(int);
-- an IMMUTABLE generation expression that counts its calls in a setting, so a recomputation is visible
CREATE FUNCTION dis_counted(b int) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  PERFORM set_config('dis.calls', (coalesce(nullif(current_setting('dis.calls', true), ''), '0')::bigint + 1)::text, false);
  RETURN b;
END $$;
CREATE FUNCTION pg_temp.keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TABLE dis_result (variant text, n int, generations bigint, wal_bytes bigint, ms numeric, locked_rows bigint);
CREATE TABLE dis_none (id int PRIMARY KEY, a int NOT NULL DEFAULT 0, b int NOT NULL DEFAULT 0,
  g int GENERATED ALWAYS AS (dis_counted(b)) STORED);
CREATE TABLE dis_disabled (LIKE dis_none INCLUDING ALL);
CREATE TABLE dis_enabled (LIKE dis_none INCLUDING ALL);
INSERT INTO dis_none (id) SELECT generate_series(1, :n);
INSERT INTO dis_disabled (id) SELECT generate_series(1, :n);
INSERT INTO dis_enabled (id) SELECT generate_series(1, :n);
CREATE TRIGGER keep BEFORE UPDATE ON dis_disabled FOR EACH ROW EXECUTE FUNCTION pg_temp.keep();
ALTER TABLE dis_disabled DISABLE TRIGGER keep;
CREATE TRIGGER keep BEFORE UPDATE ON dis_enabled FOR EACH ROW EXECUTE FUNCTION pg_temp.keep();
VACUUM (FREEZE) dis_none, dis_disabled, dis_enabled;
CHECKPOINT;

CREATE FUNCTION pg_temp.measure(variant text, tab regclass, n int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before pg_lsn; started timestamptz; elapsed numeric;
BEGIN
  PERFORM set_config('dis.calls', '0', false);
  before := pg_current_wal_insert_lsn();
  started := clock_timestamp();
  EXECUTE format('UPDATE %s SET a = 1', tab);    -- feeds no generated column
  elapsed := extract(epoch FROM clock_timestamp() - started) * 1000;
  EXECUTE format('INSERT INTO dis_result SELECT %L, %s, %s, %s, %s, (SELECT count(*) FROM %s WHERE xmax <> ''0'')',
    variant, n, current_setting('dis.calls')::bigint, pg_current_wal_insert_lsn() - before, round(elapsed, 1), tab);
END $$;
SELECT pg_temp.measure('no trigger', 'dis_none', :n);
SELECT pg_temp.measure('disabled BEFORE ROW UPDATE trigger', 'dis_disabled', :n);
SELECT pg_temp.measure('enabled BEFORE ROW UPDATE trigger', 'dis_enabled', :n);
SELECT variant, n, generations, wal_bytes, ms, locked_rows FROM dis_result ORDER BY wal_bytes;
