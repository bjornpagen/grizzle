#!/usr/bin/env bash
# ab.sh <out> <family-on> <family-off> <file>...: the same network files at once on two clusters, each named by its
# port, one whose members
# fsync and one whose members do not (the caller sets fsync = off on its members first), at TEST_SEED, every member's
# waits sampled (waits.sh). Per family: <out>/<family>.out, <out>/<family>.wall, <out>/<family>.<port>.waits; and each
# member's checkpoint lines over the run, <out>/<family>.<port>.checkpoints.
set -u
: "${TEST_SEED:?the seed both runs share}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out=$1
on=$2
off=$3
shift 3
mkdir -p "$out"
run() {
	local family=$1
	shift
	# shellcheck source=cluster.sh
	TOOLCHAIN_PG_CLUSTER=$family source "$here/cluster.sh"
	local ports samplers=() start end status port
	ports=$(family_ports) || return 1
	for port in $ports; do
		TOOLCHAIN_PG_CLUSTER=$family "$here/waits.sh" "$port" "$out/$family.$port.waits" &
		samplers+=($!)
	done
	start=$(date -u +%FT%T)
	(cd "$repo_root" && TOOLCHAIN_PG_CLUSTER=$family pnpm -s test:network "$@") >"$out/$family.out" 2>&1
	status=$?
	end=$(date -u +%FT%T)
	for sampler in "${samplers[@]}"; do
		pkill -P "$sampler" || true
		kill "$sampler" 2>/dev/null || true
	done
	echo "exit=$status start=$start end=$end" >"$out/$family.wall"
	for port in $ports; do
		member_env "$port"
		cat "$GRIZZLE_PG_LOG"/postgresql-*.log | awk -v from="$start" -v to="$end" '{ at = $1 "T" substr($2, 1, 8) } at >= from && at <= to && /checkpoint (starting|complete)/' >"$out/$family.$port.checkpoints"
	done
}
run "$on" "$@" &
a=$!
run "$off" "$@" &
b=$!
wait "$a" "$b"
