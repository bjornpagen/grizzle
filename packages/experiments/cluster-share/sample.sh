#!/usr/bin/env bash
# sample.sh <port> <out>: the local cluster <port>, as its bootstrap superuser, appended to <out> as tab-separated rows
# until killed. Every second (activity.sql): S, its client backends counted by state and wait; D, each one long in a
# transaction or a statement; W, the active ones by wait event; C, each one on the CPU over a second. Every ten seconds
# (serializable.sql): R, each SERIALIZABLE transaction older than five seconds, found by its SIRead locks, a pg_locks
# read kept off the one-second rows because that read takes the predicate lock manager's partition locks.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../scripts/pg/lib.sh
source "$here/../../../scripts/pg/lib.sh"
member_env "$1"
out=$2
psql="$(pg_bin psql)"
every() {
	{
		cat "$here/$1"
		printf '\n\\watch %s\n' "$2"
	} | "$psql" -X -q -A -t -h "$GRIZZLE_PG_SOCKET" -p "$PG_PORT" -U postgres -d postgres -f - >>"$out" 2>>"$out.err"
}
every serializable.sql 10 &
every activity.sql 1
