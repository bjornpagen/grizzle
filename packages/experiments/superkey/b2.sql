-- SUPERKEY b2: the rule-only variant. Every key refs.sql added into node_v1's primary key for a superkey reference is
-- dropped, so each such containment is held by its rule alone, existence included, as its source-side trigger's probe
-- reads it (no node row meets the source row) and its node-side trigger's on DELETE. The keys into a key's own UNIQUE
-- stay. Usage: psql -f b2.sql (after refs.sql); refs.sql builds v1 with the keys again.
\set ON_ERROR_STOP on
SELECT format('ALTER TABLE %s DROP CONSTRAINT %I', c.conrelid::regclass, c.conname)
FROM pg_constraint c
JOIN sk.keyref k ON c.conrelid = ('sk.' || quote_ident(k.source || '_v1'))::regclass
WHERE c.contype = 'f' AND c.confrelid = 'sk.node_v1'::regclass
	AND (SELECT array_agg(a.attname ORDER BY o.ord) FROM unnest(c.conkey) WITH ORDINALITY o(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = o.attnum) = k.keycols
GROUP BY c.conrelid, c.conname \gexec
SELECT count(*) AS fks_into_node_v1 FROM pg_constraint WHERE contype = 'f' AND confrelid = 'sk.node_v1'::regclass;
