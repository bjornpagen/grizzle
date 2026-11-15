#!/usr/bin/env bash
# REPIN step 1-2: edullm's repin onto grizzle <grizzle rev>, as a diff on <edullm rev> (default origin/staging).
# In the port tree ($W/edullm, a clone of primer-team/edullm): check out <edullm rev> with its own submodules, point
# vendor/grizzle at <grizzle rev> and vendor/toolchain at the toolchain that grizzle commit pins, apply edullm-port.patch
# (the edullm source the repin needs; skipped where <edullm rev> already holds it), install, draft both installations'
# migrations (qti-database's Ledger, the production one, and pantry's own QtiQueries) with `grizzle generate --name
# repin-grizzle-main`, then `grizzle check` both, toolchain-pin:check and, unless REPIN_CHECK=0, edullm's whole
# `pnpm check`. Out, in $W/out/<grizzle short>/: edullm-repin.diff (git apply --index on <edullm rev>, gitlinks
# included), the sha256 of every file of both drafts and their snapshot, manifest, served and openapi files, the
# shape report (shape.py) and every log. A commit <edullm rev> that origin lacks is fetched read-only from
# ~/Documents/edullm by its full hash.
# Usage: port.sh <grizzle rev> [<edullm rev>]
set -euo pipefail
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
E="$W/edullm"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
cd "$E"
git fetch -q origin
git -C vendor/grizzle fetch -q origin
G=$(git -C vendor/grizzle rev-parse "$1^{commit}")
want=${2:-origin/staging}
if ! git rev-parse -q --verify "$want^{commit}" > /dev/null; then
	git fetch -q "$HOME/Documents/edullm" "$(git -C "$HOME/Documents/edullm" rev-parse "$want")"
fi
R=$(git rev-parse "$want^{commit}")
out="$W/out/${G:0:8}"
mkdir -p "$out"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$out/port.log"; }
log "edullm $R, grizzle $G"
git checkout -q -f "$R"
git clean -fdq -e .agents
git submodule update --init -q
git -C vendor/grizzle checkout -q "$G"
T=$(git -C vendor/grizzle ls-tree "$G" vendor/toolchain | awk '{print $3}')
git -C vendor/toolchain fetch -q origin
git -C vendor/toolchain checkout -q "$T"
if git apply --check "$S/edullm-port.patch" 2> /dev/null; then
	git apply "$S/edullm-port.patch"
	log "applied edullm-port.patch"
else
	git apply --reverse --check "$S/edullm-port.patch" && log "edullm-port.patch already in $R"
fi
pnpm install --frozen-lockfile > "$out/install.log" 2>&1 || { log "frozen install refused; installing anew"; pnpm install --no-frozen-lockfile > "$out/install.log" 2>&1; }
grizzle() { node --disable-proto=delete --disable-sigusr1 "$E/vendor/grizzle/packages/grizzle/src/cli/main.ts" "$@"; }
for pkg in packages/data/qti-database packages/qti-pie/packages/pantry; do
	n=$(basename "$pkg")
	s=$(date +%s)
	(cd "$pkg" && grizzle generate grizzle.config.ts --name repin-grizzle-main) > "$out/generate-$n.log" 2>&1
	log "generate $n exit 0, $(($(date +%s) - s)) s"
	(cd "$pkg" && grizzle check grizzle.config.ts) > "$out/check-$n.log" 2>&1
	log "check $n: $(tail -n 1 "$out/check-$n.log")"
done
pnpm -s toolchain-pin:check > "$out/toolchain-pin.log" 2>&1
log "toolchain-pin:check: $(tail -n 1 "$out/toolchain-pin.log")"
if [ "${REPIN_CHECK:-1}" != 0 ]; then
	rc=0
	pnpm check > "$out/pnpm-check.log" 2>&1 || rc=$?
	log "pnpm check exit $rc: $(grep -E '^ *Tasks:' "$out/pnpm-check.log" | tr -s ' ' | tr '\n' ' ')"
fi

index=$(mktemp)
GIT_INDEX_FILE=$index git read-tree HEAD
GIT_INDEX_FILE=$index git add -A -- . ':!.agents'
GIT_INDEX_FILE=$index git diff --cached --binary HEAD > "$out/edullm-repin.diff"
GIT_INDEX_FILE=$index git diff --cached --stat=200 HEAD > "$out/edullm-repin.stat"
rm -f "$index"
draft=$(ls -d packages/data/qti-database/install/migrations/qti/*_repin-grizzle-main | tail -n 1)
pantry=$(ls -d packages/qti-pie/packages/pantry/migrations/qti/*_repin-grizzle-main | tail -n 1)
(cd "$draft/../" && find "$(basename "$draft")" snapshot.json manifest.json served openapi -type f | LC_ALL=C sort | xargs sha256sum) > "$out/draft-sha256.txt"
(cd "$pantry/../" && find "$(basename "$pantry")" snapshot.json manifest.json served openapi -type f | LC_ALL=C sort | xargs sha256sum) > "$out/pantry-draft-sha256.txt"
echo "$(basename "$draft")" > "$out/draft-name.txt"
git show "$R:packages/data/qti-database/install/migrations/qti/manifest.json" > "$out/source-manifest.json"
python3 -I "$S/shape.py" "$draft" "$out/source-manifest.json" "$HOME/.cache/grizzle-release/AXISINDEX/in/rowcounts-41-packages" \
	"$HOME/Documents/edullm/out/qti-speed-20261115/DBSIDE/final-snapshot.txt" \
	"$HOME/.cache/grizzle-release/AXISINDEX/in/rc1target-sizes.txt" > "$out/shape.txt"
echo "$R" > "$out/edullm-rev.txt"
echo "$G" > "$out/grizzle-rev.txt"
log "diff $(wc -c < "$out/edullm-repin.diff") bytes, $(tail -n 1 "$out/edullm-repin.stat"); draft $(basename "$draft")"
