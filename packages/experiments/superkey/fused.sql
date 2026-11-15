-- SUPERKEY fused: node_v1's rule triggers, one per rule (refs.sql), replaced by one constraint trigger for all of them,
-- AFTER DELETE OR UPDATE ON node_v1, DEFERRABLE INITIALLY DEFERRED, FOR EACH ROW, whose function runs each rule's
-- probe of OLD's row: on DELETE every rule's, on UPDATE each rule whose node columns the update changed. One trigger
-- event and one function call per node row instead of one per rule and row. The source-side triggers are unchanged.
-- Usage: psql -f fused.sql (after refs.sql, with or without b2.sql)
\set ON_ERROR_STOP on
SELECT format('DROP TRIGGER %I ON sk.node_v1', name) FROM sk.rule \gexec
SELECT format($f$CREATE FUNCTION sk.node_v1_rules() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $b$
BEGIN
  %s
  RETURN OLD;
END
$b$$f$, string_agg(format($p$IF (TG_OP = 'DELETE' OR (%s) IS DISTINCT FROM (%s)) AND EXISTS (SELECT 1 FROM sk.%I r WHERE %s AND NOT EXISTS (SELECT 1 FROM sk.node_v1 t WHERE %s)) THEN
    RAISE EXCEPTION 'a write breaks a rule over a query' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = %L, SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
  END IF;$p$,
	(SELECT string_agg(format('OLD.%I', c), ', ') FROM unnest(refcols) c),
	(SELECT string_agg(format('NEW.%I', c), ', ') FROM unnest(refcols) c),
	source || '_v1',
	(SELECT string_agg(format('r.%I = OLD.%I', cols[i], refcols[i]), ' AND ') FROM generate_subscripts(cols, 1) i),
	meets, name), E'\n  ' ORDER BY name))
FROM sk.rule \gexec
CREATE CONSTRAINT TRIGGER node_v1_rules AFTER DELETE OR UPDATE ON sk.node_v1 DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION sk.node_v1_rules();
SELECT count(*) AS node_v1_triggers FROM pg_trigger WHERE tgrelid = 'sk.node_v1'::regclass AND NOT tgisinternal;
