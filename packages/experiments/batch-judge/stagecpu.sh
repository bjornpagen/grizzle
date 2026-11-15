#!/usr/bin/env bash
# batch-judge: each staged publish's server CPU (stage.sh logged every statement with its backend CPU): one line per
# package, its CPU before COMMIT and COMMIT's own (sessioncpu.py, by its database src_<n>), then the sums.
# Usage: stagecpu.sh <tag>
set -euo pipefail
tag=$1
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
S=$(dirname "$(readlink -f "$0")")
logs=$(ls -tr "$W/clusters/$tag"/log/postgresql-*.log | tr '\n' ',' | sed 's/,$//')
while IFS=$'\t' read -r n name id; do
	python3 -I "$S/sessioncpu.py" "$logs" "ledger__publisher_app@src_$n" | sed -n 's/^publish 0: statements before COMMIT: [0-9]* distinct, CPU \([0-9.]*\) s; COMMIT: wall [0-9.]* s, CPU \([0-9.]*\) s$/\1\t\2/p' | sed "s/^/$n\t$name\t/"
done < "$W/out/$tag/stage/packages.tsv" | tee "$W/out/$tag/stage/cpu.tsv" | awk -F'\t' '{b += $3; c += $4; n++} END {printf "%d publishes: CPU before COMMIT %.1f s, COMMIT %.1f s\n", n, b, c}'
