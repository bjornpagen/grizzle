-- MULTICORE: what one statement over the partitioned parents costs a backend as packages multiply: planning time
-- (EXPLAIN ANALYZE's Planning Time and its Subplans Removed), the relation locks the backend holds after it (pg_locks of
-- its own pid inside the transaction), and the backend's memory (pg_backend_memory_contexts, every context's
-- total_bytes, and CacheMemoryContext's subtree), for three shapes, each as a custom and as a generic plan
-- (plan_cache_mode set in this measuring session only), each mode twice: the first run pays the relcache loads of every
-- relation it opens (cold), the second shows the steady cost (warm); a generic plan's second run reuses the plan:
--   key:    a keyed read whose package is a parameter (plan-time pruning for a custom plan, initial pruning for a
--           generic one);
--   probe:  an existence probe whose package comes from the outer rows, as the publisher's ON CONFLICT checks are
--           written (no plan-time pruning: every partition is planned, then pruned per outer row);
--   delete: a keyed DELETE whose package is a parameter.
-- Usage: psql -d <db> -v pkg=<package> -f plancost.sql
\set QUIET on
\pset format unaligned
\pset tuples_only on
SET default_transaction_isolation = serializable;
CREATE TEMP VIEW mem AS
  SELECT (SELECT sum(total_bytes) FROM pg_backend_memory_contexts) AS total,
    (SELECT sum(c.total_bytes) FROM pg_backend_memory_contexts c, pg_backend_memory_contexts r
     WHERE r.name = 'CacheMemoryContext' AND c.path[r.level] = r.path[r.level]) AS cache;
SELECT 'partitions of qti.node: ' || count(*) FROM pg_inherits WHERE inhparent = 'qti.node'::regclass;
SELECT 'start: total ' || pg_size_pretty(total) || ', cache ' || pg_size_pretty(cache) FROM mem;
PREPARE key(text, text, bigint) AS SELECT 1 FROM qti.node WHERE package = $1 AND path = $2 AND start = $3;
PREPARE probe(text[], text[], bigint[]) AS
  SELECT count(*) FROM unnest($1, $2, $3) AS u(p, pa, s)
  WHERE EXISTS (SELECT 1 FROM qti.node n WHERE n.package = u.p AND n.path = u.pa AND n.start = u.s);
PREPARE del(text, text) AS DELETE FROM qti.attribute WHERE package = $1 AND path = $2;
\set mode force_custom_plan
\ir plancost-one.sql
\ir plancost-one.sql
\set mode force_generic_plan
\ir plancost-one.sql
\ir plancost-one.sql
SELECT 'end: total ' || pg_size_pretty(total) || ', cache ' || pg_size_pretty(cache) FROM mem;
