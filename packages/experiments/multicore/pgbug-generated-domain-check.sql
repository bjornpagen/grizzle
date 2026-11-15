-- MULTICORE: PostgreSQL 19 (rc1 and rc2) refuses an INSERT routed through a partitioned parent when a CHECK reads a
-- STORED generated column of a domain type ("attribute N of type record has wrong type"); the same INSERT into a
-- plain table or into the partition directly succeeds. preptlist.c:457-469 fills the generated column's target
-- entry with a NULL of the domain's base type. Run: psql -d <scratch database> -f pgbug-generated-domain-check.sql
DROP TABLE IF EXISTS gp, gu CASCADE;
DROP DOMAIN IF EXISTS d16 CASCADE;
CREATE DOMAIN d16 AS bit(16);
CREATE TABLE gu (k text NOT NULL, x int NOT NULL,
  g d16 GENERATED ALWAYS AS ((CASE WHEN x > 0 THEN B'0000000000000001' ELSE B'0000000000000000' END)::d16) STORED,
  CHECK (g::"bit" = B'0000000000000001' OR x <= 0));
INSERT INTO gu (k, x) VALUES ('a', 1);
SELECT 'plain table: ' || g::text FROM gu;
CREATE TABLE gp (k text NOT NULL, x int NOT NULL,
  g d16 GENERATED ALWAYS AS ((CASE WHEN x > 0 THEN B'0000000000000001' ELSE B'0000000000000000' END)::d16) STORED,
  CHECK (g::"bit" = B'0000000000000001' OR x <= 0)) PARTITION BY LIST (k);
CREATE TABLE gp_a PARTITION OF gp FOR VALUES IN ('a');
INSERT INTO gp (k, x) VALUES ('a', 1);
SELECT 'partitioned table: ' || g::text FROM gp;
INSERT INTO gp_a (k, x) VALUES ('a', 2);
SELECT 'partition directly: ' || count(*) FROM gp_a;
