#!/usr/bin/env bash
# REPIN: the two arms on production-shaped 19rc1 clusters (RC1TARGET's prefix), side by side.
#   base:  the base tree (edullm staging as committed, the production chain's grizzle) migrates its committed chain,
#          then imports g3t15 and g3-15 through its own runtime.
#   repin: the same base-tree migrate, then the port tree's draft (main's grizzle: migrate.sh, with its lock probe and
#          drift check), then the same imports through the port tree's runtime.
# Then each table's md5 over the columns both arms hold, after each import, compared; each publish's wall time, its
# statements' CPU and COMMIT's CPU (sessioncpu.py over the server log). Last, the draft migrates the base arm's database
# too, holding both packages' rows (first price.sh's rolled-back pricing on a clone of it, price-run.sh; then migrate.sh:
# its lock probe, the timed migrate, the drift check), so the draft
# is proven over stored rows, and every table's md5 over all its columns is compared once more: the base arm migrated
# after its imports against the repin arm that imported after its migrate. Both clusters are stopped at the end; their
# state stays under clusters/<tag> until the next run removes it.
# Usage: arms.sh <out dir> <base tree> <port tree> <draft folder name> <base port> <repin port>
set -uo pipefail
out=$1
base=$(readlink -f "$2")
port=$(readlink -f "$3")
draft=$4
pb=$5
pr=$6
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
export REPIN_OUT="$out"
mkdir -p "$out"
stop() { [ -d "$W/clusters/$1/data" ] && "$P/bin/pg_ctl" -D "$W/clusters/$1/data" -m fast stop > /dev/null 2>&1; true; }
for t in base repin; do stop "$t"; rm -rf "$W/clusters/$t" "$W/secrets/$t" "$out/$t"; done
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$out/arms.log"; }

bash "$S/overlay.sh" "$base"
bash "$S/overlay.sh" "$port"
log "setup base on $pb and repin on $pr"
(bash "$S/setup.sh" base "$pb" "$base" > "$out/setup-base.log" 2>&1; echo $? > "$out/setup-base.exit") &
(bash "$S/setup.sh" repin "$pr" "$base" > "$out/setup-repin.log" 2>&1 &&
	bash "$S/migrate.sh" repin "$pr" "$port" "$draft" > "$out/migrate-repin.log" 2>&1; echo $? > "$out/setup-repin.exit") &
wait
log "setup base exit $(cat "$out/setup-base.exit"), setup+migrate repin exit $(cat "$out/setup-repin.exit")"
if [ "$(cat "$out/setup-base.exit")" != 0 ] || [ "$(cat "$out/setup-repin.exit")" != 0 ]; then
	for t in base repin; do stop "$t"; done
	exit 1
fi

bash "$S/columns.sh" base "$pb" "$out/columns-base.tsv"
bash "$S/columns.sh" repin "$pr" "$out/columns-repin.tsv"
python3 -I "$S/intersect.py" "$out/columns-base.tsv" "$out/columns-repin.tsv" "$out/columns-shared.tsv" | tee "$out/columns-differ.txt"
bash "$S/table-md5.sh" base "$pb" "$out/md5-empty-base.tsv" "$out/columns-shared.tsv"
bash "$S/table-md5.sh" repin "$pr" "$out/md5-empty-repin.tsv" "$out/columns-shared.tsv"

log "imports"
(bash "$S/arm.sh" base "$pb" "$base" "$out/columns-shared.tsv" > "$out/arm-base.log" 2>&1) &
(bash "$S/arm.sh" repin "$pr" "$port" "$out/columns-shared.tsv" > "$out/arm-repin.log" 2>&1) &
wait
log "imports done"
bash "$S/price.sh" "$port/packages/data/qti-database/install/migrations/qti/$draft" > "$out/price.sql"
bash "$S/price-run.sh" base "$pb" "$out/price.sql" "$out/base/price.txt"
log "price.sql on a clone of the base arm's rows, rolled back: $(tail -n 2 "$out/base/price.txt" | tr '\n' ' ')"
bash "$S/migrate.sh" base "$pb" "$port" "$draft" > "$out/migrate-base.log" 2>&1
log "draft over the base arm's rows: exit $?"
bash "$S/columns.sh" base "$pb" "$out/columns-final-base.tsv"
bash "$S/columns.sh" repin "$pr" "$out/columns-final-repin.tsv"
python3 -I "$S/intersect.py" "$out/columns-final-base.tsv" "$out/columns-final-repin.tsv" "$out/columns-final.tsv" | tee "$out/columns-final-differ.txt"
bash "$S/table-md5.sh" base "$pb" "$out/md5-final-base.tsv" "$out/columns-final.tsv"
bash "$S/table-md5.sh" repin "$pr" "$out/md5-final-repin.tsv" "$out/columns-final.tsv"
for t in base repin; do stop "$t"; done
python3 -I "$S/compare.py" "$out" "$W/clusters" "$base" "$port" | tee "$out/compare.txt"
log "done"
