#!/usr/bin/env bash
# batch-judge: every base and batch of one arm, one after another, after gather.sh (and copysrc.sh for a second arm).
# Bases: base35 (every package but the k = 8 batch's), base42 (base35 and the k = 8 batch but the k = 1 package),
# base43 (every package), each without statistics, and base35s, base42s, base43s, the same after VACUUM ANALYZE.
# Batches, each its own run.sh: k = 1 onto base42, k = 8 onto base35 and k = 43 onto the empty qti, inserted; and the
# k = 1 package deleted from base43; each without statistics and with them (k = 43 without only).
# Usage: plan.sh <tag> <port> <sets dir>
set -uo pipefail
tag=$1
port=$2
sets=$(readlink -f "$3")
S=$(dirname "$(readlink -f "$0")")
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
log="$W/out/$tag/plan.log"
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$log"; }
awk -F'\t' 'NR==FNR{x[$1]=1;next} ($1 in x)' "$sets/base42.tsv" "$sets/k8.tsv" > "$sets/k8-not-k1.tsv"
say "bases"
bash "$S/base.sh" "$tag" "$port" base35 "$sets/base35.tsv" nostats && say "base35 $(tail -n 1 "$W/out/$tag/base-base35/load.log")"
bash "$S/base.sh" "$tag" "$port" base42 "$sets/k8-not-k1.tsv" nostats base35 && say "base42 $(tail -n 1 "$W/out/$tag/base-base42/load.log")"
bash "$S/base.sh" "$tag" "$port" base43 "$sets/k1.tsv" nostats base42 && say "base43 $(tail -n 1 "$W/out/$tag/base-base43/load.log")"
for b in base35 base42 base43; do
	bash "$S/base.sh" "$tag" "$port" "${b}s" /dev/null stats "$b" && say "${b}s $(tail -n 1 "$W/out/$tag/base-${b}s/load.log")"
done
run() { bash "$S/run.sh" "$tag" "$port" "$@" > /dev/null 2>&1; say "$2: $(tr '\n' ' ' < "$W/out/$tag/$2/summary.txt" | cut -c1-400)"; }
run base42 ins-k1-nostats insert "$sets/k1.tsv"
run base35 ins-k8-nostats insert "$sets/k8.tsv"
run base43 del-k1-nostats delete "$sets/k1.tsv"
run base42s ins-k1-stats insert "$sets/k1.tsv"
run base35s ins-k8-stats insert "$sets/k8.tsv"
run base43s del-k1-stats delete "$sets/k1.tsv"
run qti ins-k43-nostats insert "$sets/k43.tsv"
say "done"
