-- One size of repro.sql: :n rows, each UPDATE timed and its ExecutorState probed.
TRUNCATE t;
INSERT INTO t (a, b) SELECT i, i FROM generate_series(1, :n) AS i;
\timing on
SET gen_rebuild.statement = 'SET b = b + 1';
UPDATE t SET b = b + 1;
SET gen_rebuild.statement = 'SET a = a, b = b + 1';
UPDATE t SET a = a, b = b + 1;
\timing off
