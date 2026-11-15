-- An INSERT routed through a partitioned table fails with 42804 "attribute 3 of type record has wrong type" when a
-- CHECK constraint, an index expression or an index predicate reads a stored generated column whose type is a domain.
-- The same INSERT into a plain table, or straight into the partition, succeeds.
-- Run with psql -X in a scratch database; it creates the domains and tables below and drops them at the end.
\set VERBOSITY verbose
\set ON_ERROR_STOP off

SELECT version();

CREATE DOMAIN d_int AS int;

CREATE TABLE plain (k text NOT NULL, x int NOT NULL,
    g d_int GENERATED ALWAYS AS (x * 2) STORED, CONSTRAINT g_positive CHECK (g > 0));
CREATE TABLE parted (k text NOT NULL, x int NOT NULL,
    g d_int GENERATED ALWAYS AS (x * 2) STORED, CONSTRAINT g_positive CHECK (g > 0)) PARTITION BY LIST (k);
CREATE TABLE parted_a PARTITION OF parted FOR VALUES IN ('a');

-- The plan fills g with a NULL of d_int's base type, integer.
EXPLAIN (VERBOSE, COSTS OFF) INSERT INTO parted (k, x) VALUES ('a', 1);

-- Refused (42804): routed through the partitioned table.
INSERT INTO parted (k, x) VALUES ('a', 1);
INSERT INTO parted (k, x) SELECT 'a', 2;
INSERT INTO parted (k, x) VALUES ('a', 3) ON CONFLICT DO NOTHING;

-- Accepted: a plain table; the partition itself; COPY, MERGE and a row-moving UPDATE through the partitioned table;
-- and routing to a partition whose columns stand in another order, which converts the row to the partition's type.
INSERT INTO plain (k, x) VALUES ('a', 1);
INSERT INTO parted_a (k, x) VALUES ('a', 4);
COPY parted (k, x) FROM stdin;
a	5
\.
MERGE INTO parted USING (VALUES ('a', 6)) AS s (k, x) ON false
    WHEN NOT MATCHED THEN INSERT (k, x) VALUES (s.k, s.x);
CREATE TABLE parted_b (x int NOT NULL, k text NOT NULL,
    g d_int GENERATED ALWAYS AS (x * 2) STORED, CONSTRAINT g_positive CHECK (g > 0));
ALTER TABLE parted ATTACH PARTITION parted_b FOR VALUES IN ('b');
INSERT INTO parted (k, x) VALUES ('b', 7);
UPDATE parted SET k = 'b' WHERE x = 5;
SELECT tableoid::regclass AS partition, k, x, g FROM parted ORDER BY x;

-- Refused (42804) with no CHECK, when an index expression or an index predicate reads g; accepted when nothing does.
CREATE TABLE parted_index (k text NOT NULL, x int NOT NULL,
    g d_int GENERATED ALWAYS AS (x * 2) STORED) PARTITION BY LIST (k);
CREATE TABLE parted_index_a PARTITION OF parted_index FOR VALUES IN ('a');
CREATE INDEX parted_index_expr ON parted_index ((g + 1));
INSERT INTO parted_index (k, x) VALUES ('a', 1);
DROP INDEX parted_index_expr;
CREATE INDEX parted_index_pred ON parted_index (x) WHERE g > 0;
INSERT INTO parted_index (k, x) VALUES ('a', 1);
DROP INDEX parted_index_pred;
INSERT INTO parted_index (k, x) VALUES ('a', 1);

-- The shape we met: a bit(16) domain, read by a CHECK through a cast to bit.
CREATE DOMAIN d16 AS bit(16);
CREATE TABLE parted_bits (k text NOT NULL, x int NOT NULL,
    g d16 GENERATED ALWAYS AS ((CASE WHEN x > 0 THEN B'0000000000000001' ELSE B'0000000000000000' END)::d16) STORED,
    CHECK (g::"bit" = B'0000000000000001' OR x <= 0)) PARTITION BY LIST (k);
CREATE TABLE parted_bits_a PARTITION OF parted_bits FOR VALUES IN ('a');
INSERT INTO parted_bits (k, x) VALUES ('a', 1);
INSERT INTO parted_bits_a (k, x) VALUES ('a', 1);

DROP TABLE plain, parted, parted_index, parted_bits;
DROP DOMAIN d_int, d16;
