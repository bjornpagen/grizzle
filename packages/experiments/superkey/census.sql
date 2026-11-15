-- SUPERKEY census: every qti table's indexes, unique indexes and generated superkeys (sk.superkey, family axis targets
-- left out by prep.sql), each counted and sized as installed, with the table's rows, so census.py can scale each
-- table's bytes to production's row counts. One tab-separated row per table.
-- Usage: psql -At -F '\t' -f census.sql (after prep.sql)
\set ON_ERROR_STOP on
SELECT r.relname,
	(SELECT count(*) FROM pg_index i WHERE i.indrelid = r.oid) AS indexes,
	(SELECT count(*) FROM pg_index i WHERE i.indrelid = r.oid AND i.indisunique) AS uniques,
	(SELECT count(*) FROM pg_constraint c JOIN sk.superkey s ON s.conname = c.conname AND s.relname = r.relname
		WHERE c.conrelid = r.oid) AS superkeys,
	pg_relation_size(r.oid) AS heap,
	(SELECT coalesce(sum(pg_relation_size(i.indexrelid)), 0) FROM pg_index i WHERE i.indrelid = r.oid) AS index_bytes,
	(SELECT coalesce(sum(pg_relation_size(c.conindid)), 0) FROM pg_constraint c
		JOIN sk.superkey s ON s.conname = c.conname AND s.relname = r.relname WHERE c.conrelid = r.oid) AS superkey_bytes,
	(SELECT count(*) FROM pg_constraint f WHERE f.contype = 'f' AND f.confrelid = r.oid) AS fks_in,
	(SELECT count(*) FROM pg_constraint f JOIN pg_constraint c ON c.conindid = f.conindid AND c.conrelid = f.confrelid
		JOIN sk.superkey s ON s.conname = c.conname AND s.relname = r.relname
		WHERE f.contype = 'f' AND f.confrelid = r.oid) AS fks_into_superkeys,
	r.reltuples::bigint AS rows
FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE n.nspname = 'qti' AND r.relkind = 'r'
ORDER BY r.relname;
