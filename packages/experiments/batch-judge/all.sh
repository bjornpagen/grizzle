#!/usr/bin/env bash
# batch-judge: the whole run after stage.sh on the per-row arm, every step logged to out/all.log.
#   1. served k = 1 on the per-row arm (g3t15, then g3-15, into one fresh database), as served.sh ran on the judged arm;
#   2. gather.sh on the per-row arm;
#   3. batchpublish.py and `grizzle generate` in the per-row tree, then `grizzle migrate` of both arms' qti, so each
#      holds the batched publish's parameter domain (the judged tree's folder is generated and migrated beforehand);
#   4. copysrc.sh from the per-row arm to the judged one;
#   5. plan.sh on both arms at once, each on its own cluster.
# Usage: all.sh <perrow port> <judged port>
set -uo pipefail
pr=$1
pj=$2
S=$(dirname "$(readlink -f "$0")")
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$W/out/all.log"; }
say "served k=1 per-row"
bash "$S/served.sh" perrow "$pr" "$W/perrow" served-k1 alphascience-g3-v2-scroll-pilot-g3t15 g3-science-shadow-g3-15 > "$W/out/served-perrow.out" 2>&1
say "$(tr '\n' ' ' < "$W/out/perrow/served-k1/summary.txt" | cut -c1-600)"
say "gather"
bash "$S/gather.sh" perrow "$pr" > "$W/out/perrow/gather.log" 2>&1
say "gather exit $?: $(tail -n 1 "$W/out/perrow/gather.log")"
python3 -I "$S/batchpublish.py" "$W/perrow" > "$W/out/perrow/batchpublish.log" 2>&1
(cd "$W/perrow/packages/data/qti-database" && node --disable-proto=delete --disable-sigusr1 "$W/perrow/vendor/grizzle/packages/grizzle/src/cli/main.ts" \
	generate grizzle.config.ts --name batch-perrow-publishbatch) > "$W/out/perrow/generate-publishbatch.log" 2>&1
say "generate publishbatch exit $?"
(cd "$W/perrow/packages/data/qti-database" && IMPORTPAR_PORT=$pr IMPORTPAR_CA="$W/clusters/perrow/tls/ca.crt" IMPORTPAR_SECRETS="$W/secrets/perrow" \
	IMPORTPAR_DATABASE=qti node --disable-proto=delete --disable-sigusr1 "$W/perrow/vendor/grizzle/packages/grizzle/src/cli/main.ts" \
	migrate importpar.config.ts) > "$W/out/perrow/migrate-publishbatch.log" 2>&1
say "migrate publishbatch exit $?: $(tail -n 2 "$W/out/perrow/migrate-publishbatch.log" | tr '\n' ' ')"
bash "$S/copysrc.sh" perrow "$pr" judged "$pj" > "$W/out/judged/copysrc.log" 2>&1
say "copysrc exit $?: $(tail -n 3 "$W/out/judged/copysrc.log" | tr '\n' ' ')"
bash "$S/plan.sh" perrow "$pr" "$W/sets" > /dev/null 2>&1 &
bash "$S/plan.sh" judged "$pj" "$W/sets" > /dev/null 2>&1 &
wait
say "plans done"
