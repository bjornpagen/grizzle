-- The time PostgreSQL 19rc2 takes, on this private cluster, to build the indexes a repin adds CONCURRENTLY over a table
-- shaped like a Qti member of `width` main-heap bytes a row: package and path texts, int8 slots, and a filler of
-- incompressible, uncompressed bytes. Run with psql -v rows=N -v width=W against a database of its own.
\set ON_ERROR_STOP 1
\timing on
DROP TABLE IF EXISTS cost_member;
CREATE TABLE cost_member (
  package text COLLATE "C" NOT NULL,
  path text COLLATE "C" NOT NULL,
  start int8 NOT NULL,
  parent int8 NOT NULL,
  at int8 NOT NULL,
  pred int8 GENERATED ALWAYS AS (CASE WHEN at > 0 THEN at - 1 END) STORED,
  filler text STORAGE PLAIN NOT NULL,
  PRIMARY KEY (package, path, start)
);
INSERT INTO cost_member (package, path, start, parent, at, filler)
SELECT 'alphascience-g3-v2-scroll-pilot-g3t' || lpad((i % 41)::text, 2, '0'),
       'items/item-' || (i / 400)::text || '/qti.xml',
       i % 400,
       CASE WHEN i % 400 = 0 THEN 0 ELSE ((i % 400) - 1) / 8 END,
       CASE WHEN i % 400 = 0 THEN 0 ELSE ((i % 400) - 1) % 8 END,
       substr(repeat(md5(i::text) || md5((i + 1)::text), (:width / 64) + 1), 1, :width - 120)
FROM generate_series(0, :rows - 1) AS i;
VACUUM ANALYZE cost_member;
SELECT pg_size_pretty(pg_relation_size('cost_member')) AS heap, pg_relation_size('cost_member') AS heap_bytes, count(*) AS rows FROM cost_member;
SELECT clock_timestamp() AS t0 \gset
CREATE UNIQUE INDEX CONCURRENTLY cost_member_successor ON cost_member (package, path, parent, pred);
SELECT round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS unique_build_ms \gset
SELECT clock_timestamp() AS t1 \gset
CREATE INDEX CONCURRENTLY cost_member_parent ON cost_member (package, path, parent);
SELECT round(extract(epoch FROM clock_timestamp() - :'t1'::timestamptz) * 1000) AS plain_build_ms \gset
SELECT :'unique_build_ms' AS unique_build_ms, :'plain_build_ms' AS plain_build_ms,
       pg_size_pretty(pg_relation_size('cost_member_successor')) AS unique_size,
       pg_size_pretty(pg_relation_size('cost_member_parent')) AS plain_size;
