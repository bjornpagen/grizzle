-- PL/pgSQL compile time is quadratic in the number of compound statements of one function body.
--
-- The grammar computes an IF's, an ELSIF's and a CASE WHEN's line number when the statement is reduced, after its
-- body is parsed (pl_gram.y stmt_if, stmt_elsifs, case_when). The body's tokens have already advanced
-- plpgsql_location_to_lineno's cursor past that location, so it goes backwards, and location_lineno_init rescans the
-- function source from its first byte with strchr (pl_scanner.c). Compiling a body of N such statements therefore costs
-- about N times the bytes before each: O(N^2). It is paid at CREATE FUNCTION (the validator compiles the body), and
-- again at the first call in every backend, once for each trigger that runs the function.
--
-- Run with psql -X against a scratch database. Each CREATE FUNCTION below is one CASE of n WHEN arms; doubling n
-- should double the time, and on 19rc1 and master it quadruples it.

\timing on
SET check_function_bodies = on;

SELECT format(
	'CREATE OR REPLACE FUNCTION lineno_case(k int) RETURNS int LANGUAGE plpgsql AS %L',
	E'BEGIN\n  CASE k\n'
		|| string_agg(format(E'    WHEN %s THEN\n      RETURN %s;', i, i), E'\n' ORDER BY i)
		|| E'\n  END CASE;\n  RETURN 0;\nEND'
) FROM generate_series(1, 10000) AS i \gexec

SELECT format(
	'CREATE OR REPLACE FUNCTION lineno_case(k int) RETURNS int LANGUAGE plpgsql AS %L',
	E'BEGIN\n  CASE k\n'
		|| string_agg(format(E'    WHEN %s THEN\n      RETURN %s;', i, i), E'\n' ORDER BY i)
		|| E'\n  END CASE;\n  RETURN 0;\nEND'
) FROM generate_series(1, 20000) AS i \gexec

SELECT format(
	'CREATE OR REPLACE FUNCTION lineno_case(k int) RETURNS int LANGUAGE plpgsql AS %L',
	E'BEGIN\n  CASE k\n'
		|| string_agg(format(E'    WHEN %s THEN\n      RETURN %s;', i, i), E'\n' ORDER BY i)
		|| E'\n  END CASE;\n  RETURN 0;\nEND'
) FROM generate_series(1, 40000) AS i \gexec

-- The same 40000 arms as a chain of IF ... ELSIF, which takes the same path (stmt_elsifs).
SELECT format(
	'CREATE OR REPLACE FUNCTION lineno_if(k int) RETURNS int LANGUAGE plpgsql AS %L',
	E'BEGIN\n  IF k = 0 THEN\n    RETURN 0;\n'
		|| string_agg(format(E'  ELSIF k = %s THEN\n    RETURN %s;', i, i), E'\n' ORDER BY i)
		|| E'\n  END IF;\n  RETURN 0;\nEND'
) FROM generate_series(1, 40000) AS i \gexec

-- The first call in a fresh backend compiles the body again: \c opens one.
\c
\timing on
SELECT lineno_case(40000);
SELECT lineno_case(40000);

-- The line numbers a compiled body reports: arm i's RETURN is on line 2i + 2, so dividing by zero in the last arm
-- reports line 80002, and in the first line 4.
SELECT format(
	'CREATE OR REPLACE FUNCTION lineno_check(k int) RETURNS int LANGUAGE plpgsql AS %L',
	E'BEGIN\n  CASE k\n'
		|| string_agg(format(E'    WHEN %s THEN\n      RETURN 1 / (k - %s);', i, i), E'\n' ORDER BY i)
		|| E'\n  END CASE;\n  RETURN 0;\nEND'
) FROM generate_series(1, 40000) AS i \gexec
\set VERBOSITY default
SELECT lineno_check(40000);
SELECT lineno_check(1);

DROP FUNCTION lineno_case(int);
DROP FUNCTION lineno_if(int);
DROP FUNCTION lineno_check(int);
