-- Planning time of one SELECT holding n uncorrelated EXISTS sublinks, at
-- n = 500, 1000, 2000 and 4000 (in one ARRAY[], as a target list holds at
-- most 1664 entries).  Every sublink becomes an InitPlan named exists_N.
--
-- On PostgreSQL 19, choose_plan_name() tries exists_1, exists_2, ... for the
-- k-th sublink and scans the list of every name assigned so far for each
-- try, so naming them is O(n^3): each doubling of n multiplies the planning
-- time by about 8.  With the patch each name is chosen in constant time.
--
-- With -v unnamed=1, each sublink's subquery reads from an unnamed FROM-clause
-- subquery as well, so that unnamed_subquery_N is numbered beside exists_N.
--
-- Run with psql -X in a scratch database; it creates and drops one function
-- in pg_temp.  The 4000 case takes about a minute of CPU time unpatched.
\set ON_ERROR_STOP on
\if :{?unnamed}
\else
\set unnamed 0
\endif

CREATE FUNCTION pg_temp.planning_ms(n int, unnamed bool) RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE
  q text;
  plan json;
BEGIN
  SELECT 'SELECT ARRAY[' || string_agg(format(
           CASE WHEN unnamed THEN 'EXISTS (SELECT FROM (SELECT %s OFFSET 0))'
                ELSE 'EXISTS (SELECT %s)' END, i), ', ') || ']'
    INTO q
    FROM generate_series(1, n) AS i;
  EXECUTE 'EXPLAIN (SUMMARY, FORMAT JSON) ' || q INTO plan;
  RETURN (plan -> 0 ->> 'Planning Time')::numeric;
END $$;

SELECT pg_temp.planning_ms(10, :'unnamed') AS warm_up_ms;

SELECT n, round(pg_temp.planning_ms(n, :'unnamed'), 1) AS planning_ms
FROM unnest('{500,1000,2000,4000}'::int[]) AS n;

DROP FUNCTION pg_temp.planning_ms(int, bool);
