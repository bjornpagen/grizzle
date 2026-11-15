#!/usr/bin/env bash
# tier.sh <tree> <name> <out> [files...]: the network tier of the grizzle checkout <tree> on the family
# GRIZZLE_PG_CLUSTER names, at TEST_SEED, every member sampled (sample.sh) into <out>/<name>.<port>.samples while it
# runs; the tier's output in <out>/<name>.out, its exit and wall time in <out>/<name>.wall. The family's members are
# the ones <tree> records (its scripts/pg/lib.sh family_ports), since its filesPerCluster sets their count; a family
# <tree> refuses runs nothing.
set -u
: "${GRIZZLE_PG_CLUSTER:?the family the tier runs on}" "${TEST_SEED:?the seed every run compared shares}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tree=$1
name=$2
out=$3
shift 3
# shellcheck source=../../../scripts/pg/lib.sh
source "$tree/scripts/pg/lib.sh"
ports=$(family_ports) || exit 1
mkdir -p "$out"
samplers=()
stop() {
	for sampler in "${samplers[@]}"; do
		pkill -P "$sampler" || true
		kill "$sampler" 2>/dev/null || true
	done
}
trap stop EXIT
for port in $ports; do
	"$here/sample.sh" "$port" "$out/$name.$port.samples" &
	samplers+=($!)
done
start=$(date +%s.%N)
(cd "$tree" && pnpm -s test:network "$@") >"$out/$name.out" 2>&1
code=$?
end=$(date +%s.%N)
echo "exit=$code wall=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.3f", b - a }') start=$start end=$end" >"$out/$name.wall"
