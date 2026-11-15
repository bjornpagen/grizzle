-- SUPERKEY indexes: each of qti.node's indexes built on both node copies of prep.sql, node_v1 skipping the generated
-- superkeys (sk.superkey), the primary key's as each copy's PRIMARY KEY. Any index either copy holds is dropped first.
-- Usage: psql -f indexes.sql (after prep.sql)
\set ON_ERROR_STOP on
SET maintenance_work_mem = '1GB';
SELECT format('ALTER TABLE %s DROP CONSTRAINT %I', conrelid::regclass, conname) FROM pg_constraint
WHERE conrelid IN ('sk.node_v0'::regclass, 'sk.node_v1'::regclass) AND contype IN ('p', 'u') \gexec
SELECT format('DROP INDEX %s', indexrelid::regclass) FROM pg_index
WHERE indrelid IN ('sk.node_v0'::regclass, 'sk.node_v1'::regclass) \gexec
DROP TABLE IF EXISTS sk.index_plan;
CREATE TABLE sk.index_plan AS
SELECT v.variant, i.indexrelid::regclass::text AS source, c.conname, c.contype,
	v.variant || '_' || row_number() OVER (PARTITION BY v.variant ORDER BY i.indexrelid) AS name,
	regexp_replace(
		regexp_replace(pg_get_indexdef(i.indexrelid), '^(CREATE (UNIQUE )?INDEX )(\S+)', '\1' || v.variant || '_' || row_number() OVER (PARTITION BY v.variant ORDER BY i.indexrelid)),
		' ON qti\.node ', ' ON sk.node_' || v.variant || ' ') AS ddl
FROM pg_index i
LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid AND c.conrelid = i.indrelid AND c.contype IN ('p', 'u')
CROSS JOIN (VALUES ('v0'), ('v1')) v(variant)
WHERE i.indrelid = 'qti.node'::regclass
	AND NOT (v.variant = 'v1' AND EXISTS (SELECT 1 FROM sk.superkey k WHERE k.relname = 'node' AND k.conname = c.conname));
SELECT variant, count(*) AS indexes, count(*) FILTER (WHERE ddl LIKE 'CREATE UNIQUE%') AS uniques FROM sk.index_plan GROUP BY 1 ORDER BY 1;
SELECT ddl FROM sk.index_plan ORDER BY variant, name \gexec
SELECT format('ALTER TABLE sk.node_%s ADD PRIMARY KEY USING INDEX %I', variant, name) FROM sk.index_plan WHERE contype = 'p' \gexec
VACUUM (ANALYZE) sk.node_v0, sk.node_v1;
SELECT c.relname, pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS indexes,
	(SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) AS n_indexes,
	(SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique) AS n_unique,
	c.reltuples::bigint AS rows
FROM pg_class c WHERE c.oid IN ('sk.node_v0'::regclass, 'sk.node_v1'::regclass, 'qti.node'::regclass) ORDER BY 1;
