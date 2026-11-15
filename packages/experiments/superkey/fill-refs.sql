-- SUPERKEY fill-refs: every referencing copy of refs.sql at production scale, as node's copies are: the package's rows
-- of each referencing table, once per renamed copy of prep.sql (sk.names), each under its copy's package name, so it
-- meets that copy's node rows. Written with session_replication_role = replica, which fires no trigger, foreign keys'
-- and rules' included: the rows are the package's own, valid by construction. Then every copy is analyzed, so a probe
-- or a foreign key's check plans against production's sizes.
-- Usage: psql -v pkg=<published package> -f fill-refs.sql (after refs.sql)
\set ON_ERROR_STOP on
SET session_replication_role = replica;
SELECT format('INSERT INTO sk.%I (%s) SELECT %s FROM qti.%I s CROSS JOIN sk.names p WHERE s.package = %L',
	s.source || '_' || v, c.cols, c.renamed, s.source, :'pkg')
FROM (SELECT DISTINCT source FROM sk.fk) s
CROSS JOIN (VALUES ('v0'), ('v1')) x(v)
CROSS JOIN LATERAL (SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS cols,
		string_agg(CASE WHEN attname = 'package' THEN 'p.name' ELSE 's.' || quote_ident(attname) END, ', ' ORDER BY attnum) AS renamed
	FROM pg_attribute WHERE attrelid = ('qti.' || quote_ident(s.source))::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '') c
\gexec
RESET session_replication_role;
SELECT format('VACUUM (ANALYZE) sk.%I', source || '_' || v) FROM (SELECT DISTINCT source FROM sk.fk) s CROSS JOIN (VALUES ('v0'), ('v1')) x(v) \gexec
SELECT sum(c.reltuples)::bigint AS rows FROM pg_class c WHERE c.relnamespace = 'sk'::regnamespace AND c.relname LIKE '%\_v0' AND c.relname <> 'node_v0';
