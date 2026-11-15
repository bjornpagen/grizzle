#!/usr/bin/env bash
# REPIN (copied from FAMWRITE, from BULKLOAD): one profiled publish of one package into a cluster setup.sh made, through the given
# scratch's importpar-publish.ts (edullm's publishPackage with S3 left out, one SERIALIZABLE transaction as
# publisher_app). Before it: statistics reset, pg_stat_statements tracking nested statements and planning, every
# top-level statement logged with its duration (log_min_duration_statement = 0, the timeline), and auto_explain logging
# the plan, with actual row counts but no per-node timing, of every statement, nested ones included, that ran longer
# than <explainMs>. A sampler records each backend's state and CPU each second. After it: pg_stat_user_functions,
# pg_stat_statements, pg_stat_user_tables. Everything lands in $REPIN_OUT/<tag>/<name>/ (one folder per package, so a second
# import into the same cluster keeps the first one's profile); the server log is clusters/<tag>/log/.
# Usage: run-profile.sh <tag> <port> <scratch dir> <package dir> <name> <explainMs>
set -uo pipefail
tag=$1
port=$2
scratch=$(readlink -f "$3")
dir=$4
name=$5
explain=$6
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
out="$REPIN_OUT/$tag/$name"
mkdir -p "$out"
rm -f "$out/stop"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
driver="$scratch/packages/platform/data-infrastructure"
test -f "$driver/scripts/importpar-publish.ts" || { echo "no importpar-publish.ts under $driver" >&2; exit 2; }
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }

admin -d postgres <<SQL
ALTER SYSTEM SET log_min_duration_statement = 0;
ALTER SYSTEM SET log_statement_stats = on;
ALTER SYSTEM SET auto_explain.log_min_duration = '${explain}ms';
ALTER SYSTEM SET auto_explain.log_nested_statements = on;
ALTER SYSTEM SET auto_explain.log_analyze = on;
ALTER SYSTEM SET auto_explain.log_timing = off;
ALTER SYSTEM SET auto_explain.log_verbose = off;
ALTER SYSTEM SET pg_stat_statements.track = 'all';
ALTER SYSTEM SET pg_stat_statements.track_planning = on;
SELECT pg_reload_conf();
SQL
admin -d qti -c "SELECT pg_stat_reset()" >/dev/null
admin -d postgres -c "SELECT pg_stat_statements_reset()" >/dev/null

bash "$S/sample.sh" "$tag" "$port" "$out" &
sampler=$!
echo "scratch $scratch $(git -C "$scratch" rev-parse --short HEAD) grizzle $(git -C "$scratch/vendor/grizzle" rev-parse --short HEAD) package $dir" > "$out/when.txt"
date -u +"start %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/when.txt"
(cd "$driver" && PGAPPNAME="repin-$tag" IMPORTPAR_PORT=$port IMPORTPAR_CA="$state/tls/ca.crt" \
	IMPORTPAR_SECRETS="$W/secrets/$tag" \
	/usr/bin/time -f "wall %e s, user %U s, sys %S s, maxrss %M kB" \
	node scripts/importpar-publish.ts "$dir" "$name") > "$out/publish.log" 2>&1
echo "exit $?" >> "$out/publish.log"
date -u +"end %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/when.txt"
touch "$out/stop"
wait $sampler

admin -d qti -F $'\t' -c "SELECT funcname, calls, round(total_time::numeric, 1), round(self_time::numeric, 1) FROM pg_stat_user_functions ORDER BY total_time DESC" > "$out/functions.tsv"
admin -d postgres -F $'\t' -c "SELECT s.toplevel, s.calls, round(s.total_exec_time::numeric, 1), round(s.total_plan_time::numeric, 1), s.plans, s.rows, s.generic_plan_calls, s.custom_plan_calls, s.queryid, left(regexp_replace(s.query, '\s+', ' ', 'g'), 400) FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = 'qti' ORDER BY s.total_exec_time DESC" > "$out/statements.tsv" 2> "$out/statements.err"
admin -d postgres -F $'\t' -c "SELECT s.queryid, s.query FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = 'qti' AND s.total_exec_time > 1000 ORDER BY s.total_exec_time DESC" > "$out/statements-full.txt"
admin -d qti -F $'\t' -c "SELECT schemaname || '.' || relname, n_live_tup, n_tup_ins, coalesce(to_char(last_autoanalyze, 'HH24:MI:SS'), '-'), (SELECT reltuples FROM pg_class WHERE oid = relid), (SELECT relpages FROM pg_class WHERE oid = relid) FROM pg_stat_user_tables ORDER BY n_tup_ins DESC" > "$out/tables.tsv"
admin -d postgres <<SQL
ALTER SYSTEM RESET log_min_duration_statement;
ALTER SYSTEM RESET log_statement_stats;
ALTER SYSTEM SET auto_explain.log_min_duration = -1;
SELECT pg_reload_conf();
SQL
cat "$out/when.txt" "$out/publish.log"
