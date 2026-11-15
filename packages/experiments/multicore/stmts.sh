#!/usr/bin/env bash
# MULTICORE: pg_stat_statements around one arm. `stmts.sh reset` empties it (every database) before the arm; `stmts.sh
# <tag>` writes the arm database's totals after it (out/<tag>/stmts.tsv): top-level calls, plans, planning seconds
# (every level), top-level execution seconds, and the ten statements that planned longest.
set -euo pipefail
M="$HOME/.cache/grizzle-release/MULTICORE"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
q() { "$P/bin/psql" -X -q -At -F $'\t' -h "$M/cluster/socket" -p 5741 -U postgres -d postgres "$@"; }
if [ "$1" = reset ]; then
	q -c "SELECT pg_stat_statements_reset()" > /dev/null
	exit 0
fi
{
	q -c "SELECT 'calls ' || sum(calls) FILTER (WHERE toplevel) || ', plans ' || sum(plans) || ', planning ' || round(sum(total_plan_time)::numeric / 1000, 1) || ' s, top-level execution ' || round((sum(total_exec_time) FILTER (WHERE toplevel))::numeric / 1000, 1) || ' s, evicted ' || (SELECT dealloc FROM pg_stat_statements_info) FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = '$1'"
	q -c "SELECT toplevel, calls, plans, round(total_plan_time::numeric, 0), round(total_exec_time::numeric, 0), left(regexp_replace(query, '\s+', ' ', 'g'), 100) FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = '$1' ORDER BY total_plan_time DESC LIMIT 10"
} > "$M/out/$1/stmts.tsv"
head -1 "$M/out/$1/stmts.tsv"
