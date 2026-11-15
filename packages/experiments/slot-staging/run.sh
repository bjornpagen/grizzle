#!/usr/bin/env bash
# slot-staging: one profiled publish of one package into a cluster BULKLOAD's setup.sh made from a scratch edullm, as
# BULKLOAD's run-profile.sh runs it (every statement logged with its duration and its backend CPU, log_statement_stats),
# the publish process sampled by procio.py, then every table's md5 under one REPEATABLE READ snapshot (FAMWRITE's
# table-md5-rr.sh's query). Output: ~/.cache/grizzle-release/BULKLOAD/out/<tag>/<name>/.
# Usage: run.sh <tag> <port> <scratch edullm> <package dir> <name>
set -uo pipefail
tag=$1
port=$2
scratch=$(readlink -f "$3")
dir=$4
name=$5
here=$(dirname "$(readlink -f "$0")")
L="$HOME/.cache/grizzle-release/BULKLOAD"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$L/clusters/$tag"
out="$L/out/$tag/$name"
mkdir -p "$out"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
driver="$scratch/packages/platform/data-infrastructure"
test -f "$driver/scripts/importpar-publish.ts"
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }

admin -d postgres <<SQL
ALTER SYSTEM SET log_min_duration_statement = 0;
ALTER SYSTEM SET log_statement_stats = on;
SELECT pg_reload_conf();
SQL
echo "scratch $scratch $(git -C "$scratch" rev-parse --short HEAD) grizzle $(git -C "$scratch/vendor/grizzle" rev-parse --short HEAD) package $dir" > "$out/when.txt"
date -u +"start %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/when.txt"
(cd "$driver" && PGAPPNAME="stage-$tag" IMPORTPAR_PORT=$port IMPORTPAR_CA="$state/tls/ca.crt" \
	IMPORTPAR_SECRETS="$L/secrets/$tag" \
	python3 -I "$here/procio.py" "$out/procio.tsv" node scripts/importpar-publish.ts "$dir" "$name") > "$out/publish.log" 2>&1
echo "exit $?" >> "$out/publish.log"
date -u +"end %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/when.txt"
admin -d postgres <<SQL
ALTER SYSTEM RESET log_min_duration_statement;
ALTER SYSTEM RESET log_statement_stats;
SELECT pg_reload_conf();
SQL
admin -d qti <<'SQL' > "$out/md5.tsv"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT CASE WHEN n.nspname = 'qti' AND c.relname = '__live_secret'
  THEN format('SELECT %L || E''\t'' || count(*) || E''\t(random by design)'' FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
  ELSE format(
  'SELECT %L || E''\t'' || count(*) || E''\t'' || coalesce(md5(string_agg(t::text, E''\n'' ORDER BY t::text COLLATE "C")), ''-'') FROM %I.%I AS t',
  n.nspname || '.' || c.relname, n.nspname, c.relname) END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp'
ORDER BY n.nspname, c.relname
\gexec
COMMIT;
SQL
cat "$out/when.txt" "$out/publish.log"
