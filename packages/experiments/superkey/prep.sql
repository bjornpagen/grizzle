-- SUPERKEY prep: two node-shaped tables at production scale in schema sk, from qti.node's rows of one published
-- package. node_v0 carries every index qti.node has; node_v1 every one but the generated superkeys listed in
-- sk.superkey (superkeys.py). Both hold :copies copies of the package's rows, each under its own package name of the
-- real name's length, and the package itself under its own name, so the referencing tables' rows (refs.sql) meet it.
-- Rows are loaded before the indexes are built (indexes.sql), as one CREATE INDEX each.
-- Usage: superkeys.py <meta.json> | tr ' ' '\t' | psql -v copies=N -v pkg=<published package> -f prep.sql
\set ON_ERROR_STOP on
SET maintenance_work_mem = '1GB';
DROP SCHEMA IF EXISTS sk CASCADE;
CREATE SCHEMA sk;
CREATE TABLE sk.superkey (relname text NOT NULL, conname text NOT NULL, PRIMARY KEY (relname, conname));
\copy sk.superkey FROM pstdin
-- A family axis's target stays: the family's own plan installs it (laws/model/plan.ts #familyPlan), whatever else
-- references it beside the axis. An axis is a key whose source holds a family's drawn or generated axis column: the
-- owner's count copy, a counted index, a predecessor, a successor, a first or last member, or a fold's before or after.
DELETE FROM sk.superkey s USING pg_constraint t, pg_class r, pg_namespace n
WHERE t.conname = s.conname AND r.oid = t.conrelid AND r.relname = s.relname AND n.oid = r.relnamespace AND n.nspname = 'qti'
	AND EXISTS (SELECT 1 FROM pg_constraint f
		CROSS JOIN LATERAL unnest(f.conkey) k(attnum)
		JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.attnum
		WHERE f.contype = 'f' AND f.confrelid = t.conrelid AND f.conindid = t.conindid
			AND a.attname ~ '^__(copy|index|pred|next|first|last|before|after)_');
SELECT count(*) AS node_superkeys FROM sk.superkey WHERE relname = 'node';
CREATE TABLE sk.result (
	at timestamptz NOT NULL DEFAULT clock_timestamp(),
	measure text NOT NULL,
	variant text NOT NULL,
	rep int NOT NULL,
	cpu_s numeric NOT NULL,
	wall_s numeric NOT NULL,
	rows bigint NOT NULL
);
SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS cols,
	string_agg(CASE WHEN attname = 'package' THEN 'p.name' ELSE 's.' || quote_ident(attname) END, ', ' ORDER BY attnum) AS renamed
FROM pg_attribute WHERE attrelid = 'qti.node'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' \gset
CREATE UNLOGGED TABLE sk.src_node AS SELECT :cols FROM qti.node WHERE package = :'pkg';
CREATE TABLE sk.names AS
SELECT g AS copy, left(:'pkg', length(:'pkg') - 5) || 'x' || lpad(g::text, 4, '0') AS name FROM generate_series(1, :copies) g;
CREATE TABLE sk.node_v0 (LIKE qti.node INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING STORAGE INCLUDING COMPRESSION);
INSERT INTO sk.node_v0 (:cols) SELECT :renamed FROM sk.src_node s CROSS JOIN sk.names p;
INSERT INTO sk.node_v0 (:cols) SELECT :cols FROM sk.src_node;
CREATE TABLE sk.node_v1 (LIKE qti.node INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING STORAGE INCLUDING COMPRESSION);
INSERT INTO sk.node_v1 (:cols) SELECT :cols FROM sk.node_v0;
