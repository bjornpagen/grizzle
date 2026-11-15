#!/usr/bin/env bash
# REPIN, one command: edullm's repin onto grizzle <grizzle rev> drafted, checked and proven on two production-shaped
# 19rc1 clusters. port.sh (the port tree, the drafts, the checks, the diff, the shape), trees.sh (the base and run
# trees), arms.sh (both arms: md5 per table and the publishes' cost), then the shape report again with the locks the
# lock probe saw and the local migrate's cost by part. Everything lands in $W/out/<grizzle short>/.
# Usage: run.sh <grizzle rev> [<edullm rev>] [<base port> <repin port>]
set -euo pipefail
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
bash "$S/port.sh" "$1" "${2:-origin/staging}"
G=$(git -C "$W/edullm/vendor/grizzle" rev-parse HEAD)
out="$W/out/${G:0:8}"
bash "$S/trees.sh" "$out"
draft=$(cat "$out/draft-name.txt")
bash "$S/arms.sh" "$out/arms" "$W/base" "$W/runport" "$draft" "${3:-47311}" "${4:-47312}" || true
folder="$W/runport/packages/data/qti-database/install/migrations/qti/$draft"
python3 -I "$S/shape.py" "$folder" "$out/source-manifest.json" "$HOME/.cache/grizzle-release/AXISINDEX/in/rowcounts-41-packages" \
	"$HOME/Documents/edullm/out/qti-speed-20261115/DBSIDE/final-snapshot.txt" \
	"$HOME/.cache/grizzle-release/AXISINDEX/in/rc1target-sizes.txt" "$out/arms/repin/locks.tsv" > "$out/shape.txt"
for t in repin base; do
	since=$(sed -n 's/^start \([0-9-]*\)T\([0-9:]*\).*/\1 \2/p' "$out/arms/$t/migrate-when.txt")
	python3 -I "$S/migratecost.py" "$(ls "$W"/clusters/$t/log/postgresql-*.log | paste -sd,)" "$folder" "$since" > "$out/arms/$t/migratecost.txt"
done
cat "$out/port.log" "$out/trees.txt" "$out/arms/compare.txt" "$out/arms/repin/migratecost.txt" "$out/arms/base/migratecost.txt"
