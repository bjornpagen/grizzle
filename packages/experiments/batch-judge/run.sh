#!/usr/bin/env bash
# batch-judge: one measured batch. A fresh database made from <base> (CREATE DATABASE ... TEMPLATE, FILE_COPY), then
# in one psql session as postgres the batch of <packages file> (batchsql.py: BEGIN, one INSERT or DELETE per table,
# COMMIT), each step's backend CPU read from /proc (cpustep.py). pg_stat_statements tracks nested statements and their
# planning, so a rule probe's or the judge's statements show with their plan and execution time; pg_stat_user_functions
# gives each rule function's time. Everything lands in out/<tag>/<label>/; summary.txt sums it (report.py). The measured
# database is dropped after, unless KEEP is set.
# Usage: run.sh <tag> <port> <base> <label> <insert|delete> <packages file>
set -uo pipefail
tag=$1
port=$2
base=$3
label=$4
mode=$5
packages=$(readlink -f "$6")
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
out="$W/out/$tag/$label"
db="m_${label//-/_}"
rm -rf "$out"
mkdir -p "$out"
psqlq() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
psqlq -d postgres <<SQL
ALTER SYSTEM SET pg_stat_statements.track = 'all';
ALTER SYSTEM SET pg_stat_statements.track_planning = on;
ALTER SYSTEM SET pg_stat_statements.max = 20000;
SELECT pg_reload_conf();
SQL
psqlq -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE $base STRATEGY FILE_COPY"
python3 -I "$S/batchsql.py" "$P/bin/psql" "$state/socket" "$port" "$db" "$mode" "$packages" "$out/steps.sql" > "$out/batchsql.txt"
psqlq -d "$db" -c "SELECT pg_stat_reset()" > /dev/null
psqlq -d postgres -c "SELECT pg_stat_statements_reset()" > /dev/null
date -u +"start %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" > "$out/when.txt"
python3 -I "$S/cpustep.py" "$P/bin/psql" "$state/socket" "$port" "$db" "$out/steps.sql" "$out/steps" > "$out/steps.tsv" 2>&1
date -u +"end %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/when.txt"
psqlq -d postgres -F $'\t' -c "SELECT s.toplevel, s.calls, round(s.total_exec_time::numeric, 1), round(s.total_plan_time::numeric, 1), s.plans, s.rows, s.generic_plan_calls, s.custom_plan_calls, s.queryid, left(regexp_replace(s.query, '\s+', ' ', 'g'), 300) FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = '$db' ORDER BY s.total_exec_time DESC" > "$out/statements.tsv"
psqlq -d "$db" -F $'\t' -c "SELECT funcname, calls, round(total_time::numeric, 1), round(self_time::numeric, 1) FROM pg_stat_user_functions ORDER BY total_time DESC" > "$out/functions.tsv"
psqlq -d "$db" -F $'\t' -c "SELECT count(*) FROM qti.package" > "$out/packages-after.txt"
python3 -I "$S/report.py" "$out" | tee "$out/summary.txt"
[ -n "${KEEP:-}" ] || psqlq -d postgres -c "DROP DATABASE $db"
