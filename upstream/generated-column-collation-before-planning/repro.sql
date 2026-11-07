-- A generation expression that calls a collatable function on constant arguments is refused with 42P22, though
-- the expression is immutable and the same expression is accepted in a CHECK, a DEFAULT and a query.
-- Run with psql -X against any database; it uses temporary tables only.
\set VERBOSITY verbose
\set ON_ERROR_STOP off

SELECT version();

-- Refused: each statement fails with 42P22 at CREATE TABLE.
CREATE TEMP TABLE g_eq (a int, b boolean GENERATED ALWAYS AS ('ab'::text = 'bb'::text) STORED);
CREATE TEMP TABLE g_lt (a int, b boolean GENERATED ALWAYS AS ('ab'::text < 'bb'::text) STORED);
CREATE TEMP TABLE g_in (a int, b int GENERATED ALWAYS AS (CASE WHEN 'ab'::text IN ('ab', 'bb') THEN 1 ELSE 2 END) STORED);
CREATE TEMP TABLE g_collate (a int, b boolean GENERATED ALWAYS AS ('ab'::text COLLATE "C" < 'bb'::text) STORED);
CREATE TEMP TABLE g_starts (a int, b boolean GENERATED ALWAYS AS (starts_with('ab'::text, 'a')) STORED);
CREATE TEMP TABLE g_greatest (a int, b text GENERATED ALWAYS AS (GREATEST('ab'::text, 'b')) STORED);
CREATE TEMP TABLE g_regex (a int, b boolean GENERATED ALWAYS AS ('ab'::text ~ 'a') STORED);
CREATE TEMP TABLE g_lower (a int, b text GENERATED ALWAYS AS (lower('AB'::text)) STORED);
CREATE TEMP TABLE g_virtual (a int, b boolean GENERATED ALWAYS AS ('ab'::text = 'bb'::text) VIRTUAL);
CREATE TEMP TABLE g_mixed (a int, b int GENERATED ALWAYS AS (CASE WHEN a > 0 OR 'ab'::text = 'ab' THEN 1 ELSE 2 END) STORED);
CREATE TEMP TABLE g_alter (a int);
ALTER TABLE g_alter ADD COLUMN b boolean GENERATED ALWAYS AS ('ab'::text = 'bb'::text) STORED;

-- Accepted: the same comparisons where collations are assigned before planning, or where an argument is a column.
CREATE TEMP TABLE ok_check (a int, CHECK ('ab'::text < 'bb'::text));
CREATE TEMP TABLE ok_default (a int, b boolean DEFAULT ('ab'::text = 'bb'::text));
CREATE TEMP TABLE ok_column (a text, b boolean GENERATED ALWAYS AS (a = 'bb'::text) STORED);
CREATE TEMP TABLE ok_index (a int);
CREATE INDEX ON ok_index (a) WHERE 'ab'::text < 'bb'::text;
SELECT 'ab'::text = 'bb'::text AS eq, 'ab'::text < 'bb'::text AS lt;
