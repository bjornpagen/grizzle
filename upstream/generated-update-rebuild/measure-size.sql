-- One size of measure.sql: :n rows in each table, then each statement kind over all of them, timed and probed.
TRUNCATE t, tp, tt, src;
INSERT INTO src SELECT i, i FROM generate_series(1, :n) AS i;
SET gen.kind = 'insert';
\echo @@ insert :n
\timing on
INSERT INTO t (a, b) SELECT a, b FROM src;
\timing off
INSERT INTO tp (a, b) SELECT a, b FROM src;
INSERT INTO tt (a, b) SELECT a, b FROM src;
VACUUM ANALYZE t, tp, tt, src;
SET gen.kind = 'update SET b';
\echo @@ update SET b :n
\timing on
UPDATE t SET b = b + 1;
\timing off
SET gen.kind = 'update SET a = a, b';
\echo @@ update SET a = a, b :n
\timing on
UPDATE t SET a = a, b = b + 1;
\timing off
SET gen.kind = 'on conflict do update SET b';
\echo @@ on conflict do update SET b :n
\timing on
INSERT INTO t (a, b) SELECT a, b FROM src ON CONFLICT (a) DO UPDATE SET b = excluded.b + 1;
\timing off
SET gen.kind = 'merge update SET b';
\echo @@ merge update SET b :n
\timing on
MERGE INTO t USING src AS s ON t.a = s.a WHEN MATCHED THEN UPDATE SET b = t.b + 1;
\timing off
SET gen.kind = 'partitioned update SET b';
\echo @@ partitioned update SET b :n
\timing on
UPDATE tp SET b = b + 1;
\timing off
SET gen.kind = 'before row trigger, update SET b';
\echo @@ before row trigger, update SET b :n
\timing on
UPDATE tt SET b = b + 1;
\timing off
