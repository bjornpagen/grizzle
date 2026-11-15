-- MULTICORE: drops, in a partitioned template, each CHECK that reads a domain-typed STORED generated column (13 on
-- 9 tables in edullm's schema), which pgbug-generated-domain-check.sql shows PostgreSQL 19 cannot check on a routed
-- INSERT. They are row-local, so they take no predicate lock and the SSI measurement is unchanged without them.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    WITH gen AS (SELECT a.attrelid, a.attnum FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid WHERE a.attgenerated = 's' AND t.typtype = 'd')
    SELECT c.conrelid::regclass AS tab, c.conname FROM pg_constraint c JOIN pg_class k ON k.oid = c.conrelid
    WHERE c.contype = 'c' AND c.conparentid = 0 AND NOT k.relispartition
      AND EXISTS (SELECT 1 FROM gen g WHERE g.attrelid = c.conrelid AND g.attnum = ANY (c.conkey))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tab, r.conname);
    RAISE NOTICE 'dropped % on %', r.conname, r.tab;
  END LOOP;
END $$;
