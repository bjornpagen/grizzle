-- MULTICORE: plancost.sql's three statements under one plan_cache_mode (:mode), each in a transaction of its own so
-- the locks it took are still held when they are counted. The caller keeps the EXPLAIN lines it wants.
SET plan_cache_mode = :mode;
SELECT '## ' || :'mode' || ' key';
BEGIN;
EXPLAIN (ANALYZE, SUMMARY, COSTS OFF, TIMING OFF) EXECUTE key(:'pkg', '/x', 1);
SELECT 'locks ' || count(*) FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation';
ROLLBACK;
SELECT '## ' || :'mode' || ' probe';
BEGIN;
EXPLAIN (ANALYZE, SUMMARY, COSTS OFF, TIMING OFF) EXECUTE probe(ARRAY[:'pkg'], ARRAY['/x'], ARRAY[1::bigint]);
SELECT 'locks ' || count(*) FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation';
ROLLBACK;
SELECT '## ' || :'mode' || ' delete';
BEGIN;
EXPLAIN (ANALYZE, SUMMARY, COSTS OFF, TIMING OFF) EXECUTE del(:'pkg', '/x');
SELECT 'locks ' || count(*) FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation';
ROLLBACK;
SELECT :'mode' || ': memory total ' || pg_size_pretty(total) || ', cache ' || pg_size_pretty(cache) FROM mem;
