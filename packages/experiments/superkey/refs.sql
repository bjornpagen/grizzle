-- SUPERKEY refs: every table with a foreign key into qti.node, twice, as LIKE qti.<table> INCLUDING ALL (its own
-- columns, CHECKs, generated columns and indexes), empty, with its foreign keys into node rebuilt on each variant:
--  v0, today's: each key into sk.node_v0 over the same columns as in qti.
--  v1, key references: a key into a generated superkey (sk.superkey) becomes a key over its key-paired columns into
--      sk.node_v1's primary key, one per (table, columns), and the containment it held becomes a rule over a query, as
--      physical/ddl/rules.ts installs one: a DEFERRABLE INITIALLY DEFERRED constraint trigger on the source, AFTER
--      INSERT OR UPDATE OF its columns, whose probe reads the source row at NEW's primary key and the node row it
--      pairs with (the navigated chain of 41e04161), and one on node, AFTER DELETE OR UPDATE OF the target's columns,
--      whose probe reads the source rows OLD's tuple may leave unmet. Each function has rules.ts's shape:
--      plpgsql, SECURITY DEFINER, SET search_path, IF EXISTS (probe) RAISE 23503.
-- Every other key, into a key's own UNIQUE (the primary key, a declared or projected key, a family axis), is the same
-- on both. A table's keys into other tables are on neither. The family axes of node into itself are left out: node is
-- the target here, and its own writes are prep.sql's.
-- Usage: psql -f refs.sql (after prep.sql and indexes.sql); it drops what an earlier run built first.
\set ON_ERROR_STOP on
SELECT format('DROP FUNCTION %s CASCADE', p.oid::regprocedure) FROM pg_proc p WHERE p.pronamespace = 'sk'::regnamespace \gexec
SELECT format('DROP TABLE %s CASCADE', c.oid::regclass) FROM pg_class c
WHERE c.relnamespace = 'sk'::regnamespace AND c.relkind = 'r'
	AND c.relname NOT IN ('node_v0', 'node_v1', 'src_node', 'names', 'superkey', 'result', 'index_plan') \gexec
CREATE TABLE sk.fk AS
SELECT c.conname, r.relname AS source,
	(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
	(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols,
	c.condeferrable, c.condeferred, t.conname AS target,
	EXISTS (SELECT 1 FROM sk.superkey s WHERE s.relname = 'node' AND s.conname = t.conname) AS superkey
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
LEFT JOIN pg_constraint t ON t.conindid = c.conindid AND t.conrelid = c.confrelid AND t.contype IN ('p', 'u')
WHERE c.contype = 'f' AND c.confrelid = 'qti.node'::regclass AND c.conrelid <> 'qti.node'::regclass;
SELECT superkey, count(*) AS fks, count(DISTINCT source) AS tables FROM sk.fk GROUP BY 1;
-- The node columns each referenced column of a superkey pairs with in the primary key: a primary key column itself, or
-- a selected side's law column over it (CASE WHEN φ THEN <column> END), by its generation expression.
CREATE TABLE sk.keycol AS
SELECT a.attname AS col, k.attname AS keycol
FROM pg_attribute a
JOIN pg_attribute k ON k.attrelid = a.attrelid AND k.attname IN ('package', 'path', 'start')
WHERE a.attrelid = 'qti.node'::regclass AND a.attnum > 0 AND NOT a.attisdropped
	AND (a.attname = k.attname OR (a.attgenerated = 's'
		AND pg_get_expr((SELECT d.adbin FROM pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum), a.attrelid)
			~ ('THEN \(?' || quote_ident(k.attname) || '\)?(::\w+)?\s+ELSE NULL(::\w+)?\s+END$')));
-- Each superkey reference's key part: the source columns paired with a column that pairs with the primary key, in the
-- key's order.
CREATE TABLE sk.keyref AS
SELECT f.conname, f.source,
	(SELECT array_agg(f.cols[i] ORDER BY array_position(ARRAY['package', 'path', 'start'], kc.keycol))
		FROM generate_subscripts(f.refcols, 1) i JOIN sk.keycol kc ON kc.col = f.refcols[i]) AS keycols
FROM sk.fk f WHERE f.superkey;
SELECT conname, source, keycols FROM sk.keyref WHERE cardinality(keycols) IS DISTINCT FROM 3;
SELECT DISTINCT format('CREATE TABLE sk.%I (LIKE qti.%I INCLUDING ALL)', source || '_' || v, source)
FROM sk.fk CROSS JOIN (VALUES ('v0'), ('v1')) x(v) \gexec
SELECT format('ALTER TABLE sk.%I ADD FOREIGN KEY (%s) REFERENCES sk.node_v0 (%s) MATCH SIMPLE%s',
	source || '_v0', (SELECT string_agg(quote_ident(c), ', ') FROM unnest(cols) c),
	(SELECT string_agg(quote_ident(c), ', ') FROM unnest(refcols) c),
	CASE WHEN condeferred THEN ' DEFERRABLE INITIALLY DEFERRED' WHEN condeferrable THEN ' DEFERRABLE' ELSE '' END)
FROM sk.fk \gexec
SELECT format('ALTER TABLE sk.%I ADD FOREIGN KEY (%s) REFERENCES sk.node_v1 (%s) MATCH SIMPLE%s',
	source || '_v1', (SELECT string_agg(quote_ident(c), ', ') FROM unnest(cols) c),
	(SELECT string_agg(quote_ident(c), ', ') FROM unnest(refcols) c),
	CASE WHEN condeferred THEN ' DEFERRABLE INITIALLY DEFERRED' WHEN condeferrable THEN ' DEFERRABLE' ELSE '' END)
FROM sk.fk WHERE NOT superkey \gexec
SELECT format('ALTER TABLE sk.%I ADD FOREIGN KEY (%s) REFERENCES sk.node_v1 (package, path, start) MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED',
	k.source || '_v1', (SELECT string_agg(quote_ident(c), ', ') FROM unnest(k.keycols) c))
FROM (SELECT DISTINCT source, keycols FROM sk.keyref) k \gexec
-- The rules: one per superkey reference, a function and a trigger on each side.
CREATE TABLE sk.rule AS
SELECT f.conname, f.source, f.cols, f.refcols, left('r_' || md5(f.conname), 40) AS name,
	(SELECT array_agg(a.attname ORDER BY k.ord) FROM pg_constraint p
		CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = p.conrelid AND a.attnum = k.attnum
		WHERE p.conrelid = ('qti.' || quote_ident(f.source))::regclass AND p.contype = 'p') AS pk,
	-- The node row a source row pairs with, read by node's primary key, then every pair compared: the navigated chain's
	-- step into node binds its key columns, a selected target's law columns over them included.
	(SELECT string_agg(format('t.%I = r.%I', kc.keycol, f.cols[i]), ' AND ' ORDER BY i)
		FROM generate_subscripts(f.refcols, 1) i JOIN sk.keycol kc ON kc.col = f.refcols[i])
	|| ' AND ' ||
	(SELECT string_agg(format('t.%I = r.%I', f.refcols[i], f.cols[i]), ' AND ' ORDER BY i) FROM generate_subscripts(f.cols, 1) i)
	AS meets
FROM sk.fk f WHERE f.superkey;
SELECT format($f$CREATE FUNCTION sk.%I() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $b$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM sk.%I r WHERE %s AND %s AND NOT EXISTS (SELECT 1 FROM sk.node_v1 t WHERE %s)) THEN
      RAISE EXCEPTION 'a write breaks a rule over a query' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = %L, SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END
$b$$f$,
	name || '_src', source || '_v1',
	(SELECT string_agg(format('r.%1$I = NEW.%1$I', p), ' AND ') FROM unnest(pk) p),
	(SELECT string_agg(format('r.%I IS NOT NULL', c), ' AND ') FROM unnest(cols) c),
	meets,
	name)
FROM sk.rule \gexec
SELECT format($f$CREATE FUNCTION sk.%I() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $b$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM sk.%I r WHERE %s AND NOT EXISTS (SELECT 1 FROM sk.node_v1 t WHERE %s)) THEN
      RAISE EXCEPTION 'a write breaks a rule over a query' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = %L, SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN OLD;
END
$b$$f$,
	name || '_tgt', source || '_v1',
	(SELECT string_agg(format('r.%I = OLD.%I', cols[i], refcols[i]), ' AND ') FROM generate_subscripts(cols, 1) i),
	meets,
	name)
FROM sk.rule \gexec
SELECT format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OF %s ON sk.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sk.%I()',
	name, (SELECT string_agg(DISTINCT quote_ident(c), ', ') FROM unnest(cols || pk) c), source || '_v1', name || '_src')
FROM sk.rule \gexec
SELECT format('CREATE CONSTRAINT TRIGGER %I AFTER DELETE OR UPDATE OF %s ON sk.node_v1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sk.%I()',
	name, (SELECT string_agg(DISTINCT quote_ident(c), ', ') FROM unnest(refcols) c), name || '_tgt')
FROM sk.rule \gexec
SELECT 'v0' AS variant, count(*) FILTER (WHERE contype = 'f') AS fks_into_node FROM pg_constraint WHERE confrelid = 'sk.node_v0'::regclass
UNION ALL
SELECT 'v1', count(*) FILTER (WHERE contype = 'f') FROM pg_constraint WHERE confrelid = 'sk.node_v1'::regclass;
SELECT count(*) AS rules, (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'sk.node_v1'::regclass) AS node_v1_triggers FROM sk.rule;
