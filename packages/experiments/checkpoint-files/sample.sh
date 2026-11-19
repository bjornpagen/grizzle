#!/usr/bin/env bash
# sample.sh <port> <out> <seconds>: the local cluster's member on <port>, every <seconds>, appended to <out> as tab-separated rows
# until killed: F, each database's files under the data directory; R, each database's relations with storage by the
# label of their schema's name (its `gz_<label>_` lead, or the schema's name otherwise).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cluster.sh
source "$here/cluster.sh"
member_env "$1"
out=$2
every=$3
psql="$(pg_bin psql)"
q() { "$psql" -X -q -A -t -F $'\t' -h "$GRIZZLE_PG_SOCKET" -p "$PG_PORT" -U postgres "$@"; }
labels="SELECT coalesce(substring(n.nspname from '^(gz_[a-z]+)_'), n.nspname), count(*) FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE c.relfilenode <> 0 GROUP BY 1"
while true; do
	at=$(date -u +%FT%TZ)
	q -d postgres -c "SELECT oid, datname, datallowconn FROM pg_catalog.pg_database" | while IFS=$'\t' read -r oid name connects; do
		echo -e "F\t$at\t$name\t$(find "$GRIZZLE_PG_DATA/base/$oid" -type f 2>/dev/null | wc -l)"
		if [[ "$connects" == "t" && "$name" != template* ]]; then
			q -d "$name" -c "$labels" 2>/dev/null | while IFS=$'\t' read -r label count; do
				echo -e "R\t$at\t$name\t$label\t$count"
			done
		fi
	done >>"$out"
	sleep "$every"
done
