#!/usr/bin/env bash
# REPIN: the proof for a port.sh output directory whose trees trees.sh made: arms.sh (both arms: md5 per table, the
# publishes' cost, the rolled-back pricing and the draft over stored rows), then the shape report again with the locks
# the lock probe saw, and each local migrate's cost by part.
# Usage: finish.sh <port.sh out dir> [<base port> <repin port>]
set -euo pipefail
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
out=$(readlink -f "$1")
draft=$(cat "$out/draft-name.txt")
bash "$S/arms.sh" "$out/arms" "$W/base" "$W/runport" "$draft" "${2:-47311}" "${3:-47312}" || true
folder="$W/runport/packages/data/qti-database/install/migrations/qti/$draft"
python3 -I "$S/shape.py" "$folder" "$out/source-manifest.json" "$HOME/.cache/grizzle-release/AXISINDEX/in/rowcounts-41-packages" \
	"$HOME/Documents/edullm/out/qti-speed-20261115/DBSIDE/final-snapshot.txt" \
	"$HOME/.cache/grizzle-release/AXISINDEX/in/rc1target-sizes.txt" "$out/arms/repin/locks.tsv" > "$out/shape.txt"
for t in repin base; do
	since=$(sed -n 's/^start \([0-9-]*\)T\([0-9:]*\).*/\1 \2/p' "$out/arms/$t/migrate-when.txt")
	python3 -I "$S/migratecost.py" "$(ls "$W"/clusters/$t/log/postgresql-*.log | paste -sd,)" "$folder" "$since" > "$out/arms/$t/migratecost.txt"
done
cat "$out/port.log" "$out/trees.txt" "$out/arms/compare.txt" "$out/arms/repin/migratecost.txt" "$out/arms/base/migratecost.txt"
