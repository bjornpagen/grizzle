#!/usr/bin/env bash
# REPIN (copied from FAMWRITE, from BULKLOAD): samples one cluster's publisher backends each second until <out dir>/stop exists:
# pg_stat_activity's state, wait event and query start for every backend in database qti, plus the backend process's own
# CPU time (utime + stime from /proc/<pid>/stat, in clock ticks) so phases can be costed in CPU seconds, which the
# machine's load does not inflate the way it inflates wall time. Appends to <out dir>/activity.tsv.
# Usage: sample.sh <tag> <port> <out dir>
set -uo pipefail
tag=$1
port=$2
out=$3
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
tick=$(getconf CLK_TCK)
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
while [ ! -e "$out/stop" ]; do
	admin -d postgres -F $'\t' -c "SELECT to_char(clock_timestamp(), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), pid, usename, state, coalesce(wait_event_type, '-'), coalesce(wait_event, '-'), to_char(xact_start, 'HH24:MI:SS.MS'), to_char(query_start, 'HH24:MI:SS.MS'), query_id, left(regexp_replace(query, '\s+', ' ', 'g'), 120) FROM pg_stat_activity WHERE datname = 'qti' AND backend_type = 'client backend' AND pid <> pg_backend_pid()" 2>/dev/null |
		while IFS=$'\t' read -r ts pid rest; do
			cpu=$(awk -v t="$tick" '{printf "%.2f", ($14 + $15) / t}' "/proc/$pid/stat" 2>/dev/null)
			printf '%s\t%s\t%s\t%s\n' "$ts" "$pid" "${cpu:--}" "$rest"
		done >> "$out/activity.tsv"
	sleep 1
done
