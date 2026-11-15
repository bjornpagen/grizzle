#!/usr/bin/env bash
# batch-judge: one real served batch, the packages of <packages file> published by one call of the publisher's
# `publishBatch` (batchpublish.py's, in <tree>; importpar-batch.ts) into a fresh database made from <base>, every
# statement logged with its backend CPU, so the CPU before COMMIT and COMMIT's own are read off the log
# (sessioncpu.py); pg_stat_statements tracks nested statements and their planning (statements.tsv).
# Usage: servedbatch.sh <tag> <port> <tree> <label> <base> <packages file>
set -uo pipefail
tag=$1
port=$2
tree=$(readlink -f "$3")
label=$4
base=$5
packages=$(readlink -f "$6")
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
PK=${BATCH_PACKAGES:-/Users/bjorn/Documents/edullm/out/qti-rebuild-20261114/packages}
state="$W/clusters/$tag"
out="$W/out/$tag/$label"
db="s_${label//-/_}"
rm -rf "$out"
mkdir -p "$out"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
psqlq() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
awk -F'\t' -v pk="$PK" '{print pk "/" $2 "/" $3 "\t" $2}' "$packages" > "$out/list.tsv"
psqlq -d postgres <<SQL
ALTER SYSTEM SET log_min_duration_statement = 0;
ALTER SYSTEM SET log_statement_stats = on;
ALTER SYSTEM SET pg_stat_statements.track = 'all';
ALTER SYSTEM SET pg_stat_statements.track_planning = on;
ALTER SYSTEM SET pg_stat_statements.max = 20000;
SELECT pg_reload_conf();
SQL
psqlq -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE $base STRATEGY FILE_COPY"
psqlq -d postgres -c "SELECT pg_stat_statements_reset()" > /dev/null
(cd "$tree/packages/platform/data-infrastructure" && PGAPPNAME="batch-$label" IMPORTPAR_PORT=$port \
	IMPORTPAR_CA="$state/tls/ca.crt" IMPORTPAR_SECRETS="$W/secrets/$tag" IMPORTPAR_DATABASE="$db" \
	/usr/bin/time -f "wall %e s, user %U s, sys %S s, maxrss %M kB" \
	node scripts/importpar-batch.ts "$out/list.tsv") > "$out/publish.log" 2>&1
echo "exit $?" >> "$out/publish.log"
psqlq -d postgres -F $'\t' -c "SELECT s.toplevel, s.calls, round(s.total_exec_time::numeric, 1), round(s.total_plan_time::numeric, 1), s.plans, s.rows, s.generic_plan_calls, s.custom_plan_calls, s.queryid, left(regexp_replace(s.query, '\s+', ' ', 'g'), 300) FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = '$db' ORDER BY s.total_exec_time DESC" > "$out/statements.tsv"
psqlq -d "$db" -c "SELECT count(*) FROM qti.package" > "$out/packages-after.txt"
psqlq -d postgres <<SQL
ALTER SYSTEM RESET log_min_duration_statement;
ALTER SYSTEM RESET log_statement_stats;
SELECT pg_reload_conf();
SQL
logs=$(ls -tr "$state"/log/postgresql-*.log | tr '\n' ',' | sed 's/,$//')
{ tail -n 3 "$out/publish.log"; python3 -I "$S/sessioncpu.py" "$logs" "ledger__publisher_app@$db"; } | tee "$out/summary.txt"
[ -n "${KEEP:-}" ] || psqlq -d postgres -c "DROP DATABASE $db"
