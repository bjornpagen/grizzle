-- MULTICORE: the per-package partitions of every partitioned table in the database, made by one call per package.
-- multicore.provision(package) creates, in one transaction, a partition FOR VALUES IN (package) of every partitioned
-- table (pg_partitioned_table), named <table, 40 bytes at most>__<16 hex of md5(package)>, owned by its parent's owner,
-- with its parent's replica identity when that is FULL (a partition does not inherit it). It returns the number of
-- partitions it created; a package's partitions that exist already are left as they are.
CREATE SCHEMA IF NOT EXISTS multicore;

CREATE OR REPLACE FUNCTION multicore.partition_name(parent regclass, package text) RETURNS name
LANGUAGE sql STABLE AS $$
  SELECT (left((SELECT relname FROM pg_class WHERE oid = parent), 40) || '__' || left(md5(package), 16))::name
$$;

CREATE OR REPLACE FUNCTION multicore.provision(package text) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  made integer := 0;
  part name;
BEGIN
  FOR t IN
    SELECT c.oid::regclass AS parent, n.nspname, pg_get_userbyid(c.relowner) AS owner, c.relreplident
    FROM pg_partitioned_table pt
    JOIN pg_class c ON c.oid = pt.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT c.relispartition
    ORDER BY n.nspname, c.relname
  LOOP
    part := multicore.partition_name(t.parent, package);
    IF to_regclass(format('%I.%I', t.nspname, part)) IS NULL THEN
      EXECUTE format('CREATE TABLE %I.%I PARTITION OF %s FOR VALUES IN (%L)', t.nspname, part, t.parent, package);
      EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', t.nspname, part, t.owner);
      IF t.relreplident = 'f' THEN
        EXECUTE format('ALTER TABLE %I.%I REPLICA IDENTITY FULL', t.nspname, part);
      END IF;
      made := made + 1;
    END IF;
  END LOOP;
  RETURN made;
END
$$;

-- multicore.provision_attach(package): the same partitions for a schema whose package-paired foreign keys are stated
-- per package (partition.py pairs, multicore.pair): each partition is created alone (LIKE its parent, which takes
-- AccessShareLock on the parent) and attached (ShareUpdateExclusiveLock on the parent, which no publisher's
-- RowExclusiveLock conflicts with), then each pair's foreign key is added from this package's partition to this
-- package's partition of the referenced table (ShareRowExclusiveLock on those two new partitions alone).
CREATE TABLE IF NOT EXISTS multicore.pair (
  tab regclass NOT NULL,
  name name NOT NULL,
  columns text NOT NULL,
  referenced regclass NOT NULL,
  referenced_columns text NOT NULL,
  tail text NOT NULL
);

CREATE OR REPLACE FUNCTION multicore.provision_attach(package text) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  made integer := 0;
  part name;
BEGIN
  FOR t IN
    SELECT c.oid::regclass AS parent, n.nspname, pg_get_userbyid(c.relowner) AS owner, c.relreplident
    FROM pg_partitioned_table pt
    JOIN pg_class c ON c.oid = pt.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT c.relispartition
    ORDER BY n.nspname, c.relname
  LOOP
    part := multicore.partition_name(t.parent, package);
    CONTINUE WHEN to_regclass(format('%I.%I', t.nspname, part)) IS NOT NULL;
    EXECUTE format('CREATE TABLE %I.%I (LIKE %s INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING STORAGE INCLUDING COMPRESSION)',
      t.nspname, part, t.parent);
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', t.nspname, part, t.owner);
    IF t.relreplident = 'f' THEN
      EXECUTE format('ALTER TABLE %I.%I REPLICA IDENTITY FULL', t.nspname, part);
    END IF;
    EXECUTE format('ALTER TABLE %s ATTACH PARTITION %I.%I FOR VALUES IN (%L)', t.parent, t.nspname, part, package);
    made := made + 1;
  END LOOP;
  FOR t IN
    SELECT p.*, tn.nspname AS tschema, rn.nspname AS rschema
    FROM multicore.pair p
    JOIN pg_class tc ON tc.oid = p.tab JOIN pg_namespace tn ON tn.oid = tc.relnamespace
    JOIN pg_class rc ON rc.oid = p.referenced JOIN pg_namespace rn ON rn.oid = rc.relnamespace
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I.%I(%s)%s',
      t.tschema, multicore.partition_name(t.tab, package), t.name, t.columns,
      t.rschema, multicore.partition_name(t.referenced, package), t.referenced_columns, t.tail);
  END LOOP;
  RETURN made;
END
$$;
