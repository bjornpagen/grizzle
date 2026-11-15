#!/usr/bin/env bash
# waits.sh <port> <out>: the local cluster <port>'s active client backends every second, by what each waits on (its
# wait event, or the CPU), a `W <time> <event>=<count> ...` line appended to <out> until killed.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../scripts/pg/lib.sh
source "$here/../../../scripts/pg/lib.sh"
member_env "$1"
{
	cat <<'SQL'
SELECT concat_ws(E'\t', 'W', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS'),
	coalesce(string_agg(e || '=' || n, ' ' ORDER BY n DESC), ''))
FROM (SELECT coalesce(wait_event_type || ':' || wait_event, 'CPU') AS e, count(*) AS n
	FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active'
		AND pid <> pg_catalog.pg_backend_pid() GROUP BY 1) AS w
SQL
	printf '\\watch 1\n'
} | "$(pg_bin psql)" -X -q -A -t -h "$GRIZZLE_PG_SOCKET" -p "$PG_PORT" -U postgres -d postgres -f - >>"$2" 2>>"$2.err"
