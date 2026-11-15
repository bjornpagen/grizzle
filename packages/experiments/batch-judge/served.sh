#!/usr/bin/env bash
# batch-judge: real served publishes, one after another into one fresh database made from qti, each edullm's
# publishPackage through <tree>'s importpar-publish.ts (one SERIALIZABLE transaction as publisher_app), every statement
# logged with its backend CPU, so each publish's CPU before COMMIT and COMMIT's own are read off the log
# (sessioncpu.py); pg_stat_statements tracks nested statements and their planning (statements-<n>.tsv).
# Usage: served.sh <tag> <port> <tree> <label> <name>...
set -uo pipefail
tag=$1
port=$2
tree=$(readlink -f "$3")
label=$4
shift 4
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
psqlq -d postgres <<SQL
ALTER SYSTEM SET log_min_duration_statement = 0;
ALTER SYSTEM SET log_statement_stats = on;
ALTER SYSTEM SET pg_stat_statements.track = 'all';
ALTER SYSTEM SET pg_stat_statements.track_planning = on;
ALTER SYSTEM SET pg_stat_statements.max = 20000;
SELECT pg_reload_conf();
SQL
psqlq -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE qti STRATEGY FILE_COPY"
n=0
for name in "$@"; do
	id=$(awk -F'\t' -v n="$name" '$1 == n {print $2}' "$PK/CURRENT.tsv")
	psqlq -d postgres -c "SELECT pg_stat_statements_reset()" > /dev/null
	(cd "$tree/packages/platform/data-infrastructure" && PGAPPNAME="batch-$label" IMPORTPAR_PORT=$port \
		IMPORTPAR_CA="$state/tls/ca.crt" IMPORTPAR_SECRETS="$W/secrets/$tag" IMPORTPAR_DATABASE="$db" \
		/usr/bin/time -f "wall %e s, user %U s, sys %S s, maxrss %M kB" \
		node scripts/importpar-publish.ts "$PK/$name/$id" "$name") > "$out/publish-$n.log" 2>&1
	echo "exit $?" >> "$out/publish-$n.log"
	psqlq -d postgres -F $'\t' -c "SELECT s.toplevel, s.calls, round(s.total_exec_time::numeric, 1), round(s.total_plan_time::numeric, 1), s.plans, s.rows, s.generic_plan_calls, s.custom_plan_calls, s.queryid, left(regexp_replace(s.query, '\s+', ' ', 'g'), 300) FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = '$db' ORDER BY s.total_exec_time DESC" > "$out/statements-$n.tsv"
	n=$((n + 1))
done
psqlq -d postgres <<SQL
ALTER SYSTEM RESET log_min_duration_statement;
ALTER SYSTEM RESET log_statement_stats;
SELECT pg_reload_conf();
SQL
logs=$(ls -tr "$state"/log/postgresql-*.log | tr '\n' ',' | sed 's/,$//')
for f in "$out"/publish-*.log; do echo "$(basename "$f"): $(grep -o '"name":"[^"]*"\|"outcome":"[^"]*"\|"publishMs":[0-9]*' "$f" | tr '\n' ' ') $(grep '^wall\|^exit' "$f" | tr '\n' ' ')"; done | tee "$out/summary.txt"
python3 -I "$S/sessioncpu.py" "$logs" "ledger__publisher_app@$db" | tee -a "$out/summary.txt"
