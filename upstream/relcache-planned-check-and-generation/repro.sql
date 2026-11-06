-- CHECK constraints and stored generation expressions are planned again in every statement that needs them.
--
-- ExecRelCheck (execMain.c) reads each CHECK constraint's ccbin with stringToNode, and ExecInitGenerated
-- (nodeModifyTable.c) each generation expression with build_column_default, and both run the result through
-- ExecPrepareExpr in every statement. ExecPrepareExpr calls expression_planner, which calls every IMMUTABLE function
-- whose arguments are constants and copies its result into the tree. So a CHECK constraint or a stored generated
-- column that reads such a function calls it, and copies its result, in every INSERT or UPDATE, where an index
-- expression is planned once per relcache entry (RelationGetIndexExpressions) and a domain's CHECK once per backend
-- (load_domaintype_info).
--
-- Run with psql -X against a scratch database. Part 1 counts the calls: 1000 one-row INSERTs call the function 1000
-- times on master, and once with the patch. Part 2 times 10000 one-row INSERTs each into a bare table, a table with a
-- CHECK constraint and a table with a stored generated column, both over a SQL function that returns a 128 kB
-- constant, and 1000 into a table whose CHECK constraint holds that constant as a literal, which stringToNode reads
-- back from ccbin in every statement. The script drops what it creates.

\set ON_ERROR_STOP on

-- 1. Calls

-- CREATE TABLE plans a generation expression too, to check its immutability, so the counter exists first.
SET relexpr.calls = 0;
CREATE FUNCTION relexpr_counted() RETURNS bit varying LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  PERFORM set_config('relexpr.calls', (current_setting('relexpr.calls')::int + 1)::text, false);
  RETURN B'11';
END $$;
CREATE TABLE relexpr_counted_check (k int NOT NULL,
  CHECK ((substring(relexpr_counted() FROM k + 1 FOR 1) = B'1') IS TRUE));
CREATE TABLE relexpr_counted_gen (k int NOT NULL,
  admitted bool GENERATED ALWAYS AS (substring(relexpr_counted() FROM k + 1 FOR 1) = B'1') STORED);

SET relexpr.calls = 0;
DO $$ BEGIN FOR i IN 1..1000 LOOP INSERT INTO relexpr_counted_check VALUES (1); END LOOP; END $$;
SELECT current_setting('relexpr.calls')::int AS check_calls_in_1000_inserts;

SET relexpr.calls = 0;
DO $$ BEGIN FOR i IN 1..1000 LOOP INSERT INTO relexpr_counted_gen VALUES (1); END LOOP; END $$;
SELECT current_setting('relexpr.calls')::int AS generated_calls_in_1000_inserts;

-- 2. Time

-- A SQL function that returns a constant of 2^20 bits, 128 kB, as a closed set of values does when stored as a bitmap.
SELECT format(
	'CREATE FUNCTION relexpr_big() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN B%L',
	repeat('01', 524288)
) \gexec

CREATE TABLE relexpr_bare (k int NOT NULL);
CREATE TABLE relexpr_check (k int NOT NULL,
  CHECK ((substring(relexpr_big() FROM k + 1 FOR 1) = B'1') IS TRUE));
CREATE TABLE relexpr_gen (k int NOT NULL,
  admitted bool GENERATED ALWAYS AS (substring(relexpr_big() FROM k + 1 FOR 1) = B'1') STORED);
SELECT format(
	'CREATE TABLE relexpr_literal (k int NOT NULL, CHECK ((substring(B%L FROM k + 1 FOR 1) = B%L) IS TRUE))',
	repeat('01', 524288), '1'
) \gexec

-- Each table once to warm the caches, then each three times; the time divided by the count of INSERTs is the cost
-- of one.
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_bare VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_check VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_gen VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..1000 LOOP INSERT INTO relexpr_literal VALUES (1); END LOOP; END $$;
\timing on
\echo bare, 10000 INSERTs
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_bare VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_bare VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_bare VALUES (1); END LOOP; END $$;
\echo CHECK over the function, 10000 INSERTs
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_check VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_check VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_check VALUES (1); END LOOP; END $$;
\echo generated column over the function, 10000 INSERTs
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_gen VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_gen VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..10000 LOOP INSERT INTO relexpr_gen VALUES (1); END LOOP; END $$;
\echo CHECK holding the constant, 1000 INSERTs
DO $$ BEGIN FOR i IN 1..1000 LOOP INSERT INTO relexpr_literal VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..1000 LOOP INSERT INTO relexpr_literal VALUES (1); END LOOP; END $$;
DO $$ BEGIN FOR i IN 1..1000 LOOP INSERT INTO relexpr_literal VALUES (1); END LOOP; END $$;
\timing off

DROP TABLE relexpr_counted_check, relexpr_counted_gen, relexpr_bare, relexpr_check, relexpr_gen, relexpr_literal;
DROP FUNCTION relexpr_counted(), relexpr_big();
RESET relexpr.calls;
