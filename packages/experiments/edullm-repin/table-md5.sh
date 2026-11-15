#!/usr/bin/env bash
# REPIN (from FAMWRITE's and IMPORTPAR's table-md5): one line per table of a cluster's qti database outside the system
# schemas, "<schema>.<table>\t<rows>\t<md5>", the md5 over every row's text ordered by that text under the C collation,
# in one REPEATABLE READ READ ONLY transaction, so every table is read under one snapshot. The row's text is
# row(<columns>)::text over the columns <columns file> lists for the table ("<schema>.<table>\t<c1>,<c2>,..."), so two
# arms whose schemas differ compare the columns both hold; a table the file does not list is read whole. With no
# columns file, every table is read whole. qti.__live_secret, random by design, prints its row count alone.
# Usage: table-md5.sh <tag> <port> <out file> [<columns file>]
set -euo pipefail
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
cols=${4:-/dev/null}
psql() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$W/clusters/$1/socket" -p "$2" -U postgres -d qti "${@:3}"; }
psql "$1" "$2" -c "CREATE TEMP TABLE c (t text PRIMARY KEY, cols text)" -c "\copy c FROM '$cols'" \
	-c "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" -f - -c "COMMIT" > "$3" <<'SQL'
SELECT CASE WHEN n.nspname = 'qti' AND c.relname = '__live_secret'
  THEN format('SELECT %L || E''\t'' || count(*) || E''\t(random by design)'' FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
  ELSE format(
  'SELECT %L || E''\t'' || count(*) || E''\t'' || coalesce(md5(string_agg(%s, E''\n'' ORDER BY %s COLLATE "C")), ''-'') FROM %I.%I AS t',
  n.nspname || '.' || c.relname,
  coalesce('row(' || k.cols || ')::text', 't::text'), coalesce('row(' || k.cols || ')::text', 't::text'),
  n.nspname, c.relname) END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN (SELECT t, (SELECT string_agg(format('t.%I', x), ', ' ORDER BY ord) FROM unnest(string_to_array(cols, ',')) WITH ORDINALITY AS u(x, ord)) AS cols FROM c) AS k
  ON k.t = n.nspname || '.' || c.relname
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp'
ORDER BY n.nspname, c.relname
\gexec
SQL
