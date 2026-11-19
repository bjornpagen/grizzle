#!/usr/bin/env bash
# per-file.sh <seconds> <out> <file>...: each network test file alone, on the first member of the cluster
# TOOLCHAIN_PG_CLUSTER names (a lone file takes Vitest's first free worker, 1, so member 1), for at most <seconds>,
# between two CHECKPOINTs, at TEST_SEED. Each run is a process group of its own (setsid), ended whole at <seconds> and
# waited for to its last process, so no file's workers outlive its window into the next. A line to <out> per file: the
# file, the seconds it ran, the files the member's checkpoints synced from the first CHECKPOINT's end to the second's
# (every checkpoint between, timed ones too), and the test run's exit status, 124 where <seconds> ended it.
set -u
: "${TOOLCHAIN_PG_CLUSTER:?the cluster}" "${TEST_SEED:?the seed}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
seconds=$1
out=$2
shift 2
# shellcheck source=cluster.sh
source "$here/cluster.sh"
log() { find "$GRIZZLE_PG_LOG" -name 'postgresql-*.log' -newermt '-1 day' | sort | tail -1; }
checkpoint() { "$(pg_bin psql)" -X -q -h "$GRIZZLE_PG_SOCKET" -p "$PG_PORT" -U postgres -d postgres -c CHECKPOINT; }
for file in "$@"; do
	checkpoint
	logfile=$(log)
	from=$(wc -l <"$logfile")
	start=$(date +%s)
	(cd "$repo_root" && exec setsid pnpm -s test:network "$file") >"$out.$(basename "$file").log" 2>&1 &
	group=$!
	waited=0
	while kill -0 "$group" 2>/dev/null && ((waited < seconds)); do
		sleep 1
		waited=$((waited + 1))
	done
	if kill -0 "$group" 2>/dev/null; then
		kill -TERM -- "-$group"
		wait "$group"
		status=124
	else
		wait "$group"
		status=$?
	fi
	while pgrep -g "$group" >/dev/null; do
		sleep 1
	done
	ran=$(($(date +%s) - start))
	checkpoint
	synced=$(tail -n "+$((from + 1))" "$logfile" | grep -oE 'sync files=[0-9]+' | awk -F= '{s += $2} END {print s + 0}')
	printf '%s\t%d\t%d\t%d\n' "$file" "$ran" "$synced" "$status" >>"$out"
done
