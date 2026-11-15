-- SUPERKEY v1-reads: the B-tree the index engine would draft on node_v1 for a served read a dropped superkey served.
-- reads.sh shows the publisher's set-difference read (publisher statement 3) scanning node's UNIQUE (package, path,
-- start, end) for "start <= x AND end > x" within a document; with the superkey gone the engine places that request
-- on an index of its own (physical/indexes/engine.ts), so v1 carries one, non-unique, over the same columns. Its read
-- over (package, path, parent) falls to the family key (package, path, parent, at), which v1 keeps.
-- Usage: psql -f v1-reads.sql (after indexes.sql)
\set ON_ERROR_STOP on
CREATE INDEX v1_reads_end ON sk.node_v1 USING btree (package, path, start, "end");
ANALYZE sk.node_v1;
SELECT count(*) AS indexes, count(*) FILTER (WHERE indisunique) AS uniques, pg_size_pretty(pg_indexes_size('sk.node_v1')) AS bytes
FROM pg_index WHERE indrelid = 'sk.node_v1'::regclass;
