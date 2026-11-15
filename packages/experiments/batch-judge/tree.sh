#!/usr/bin/env bash
# batch-judge: one edullm tree over a grizzle commit, its QTI database's installation drafted. A clone of edullm at
# <edullm rev> (default origin/staging) in <tree>, vendor/grizzle at <grizzle rev> and vendor/toolchain at the commit
# that grizzle pins, edullm-port.patch (edullm-repin's) and edullm-overlay.patch (the local publish and migrate config,
# its database an input) applied, then <grizzle patch>, if given, applied to vendor/grizzle's working tree, installed,
# and `grizzle generate --name batch-<arm>` of packages/data/qti-database. The log lands in <tree>.log.
# Usage: tree.sh <tree> <arm> <grizzle rev> [<grizzle patch>] [<edullm rev>]
set -euo pipefail
tree=$1
arm=$2
rev=$3
patch=${4:-}
want=${5:-origin/staging}
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
S=$(dirname "$(readlink -f "$0")")
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
log="$tree.log"
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$log"; }
[ -d "$tree/.git" ] || git clone -q --reference "$W/edullm" https://github.com/primer-team/edullm.git "$tree"
cd "$tree"
git fetch -q origin
R=$(git rev-parse "$want^{commit}")
git checkout -q -f "$R"
git clean -fdq -e .agents
git submodule update --init -q --reference "$HOME/Documents/grizzle" vendor/grizzle
git -C vendor/grizzle fetch -q origin
G=$(git -C vendor/grizzle rev-parse "$rev^{commit}")
git -C vendor/grizzle checkout -q -f "$G"
git -C vendor/grizzle clean -fdq
T=$(git -C vendor/grizzle ls-tree "$G" vendor/toolchain | awk '{print $3}')
git submodule update --init -q --reference "$HOME/Documents/grizzle/vendor/toolchain" vendor/toolchain
git -C vendor/toolchain fetch -q origin
git -C vendor/toolchain checkout -q "$T"
say "edullm $R, grizzle $G, toolchain $T"
if git apply --check "$S/edullm-port.patch" 2> /dev/null; then
	git apply "$S/edullm-port.patch"
	say "applied edullm-port.patch"
fi
git apply "$S/edullm-overlay.patch"
if [ -n "$patch" ]; then
	git -C vendor/grizzle apply "$(readlink -f "$patch")"
	say "applied $(basename "$patch") to vendor/grizzle ($(git -C vendor/grizzle diff --shortstat))"
fi
pnpm install --frozen-lockfile > "$tree.install.log" 2>&1 || {
	say "frozen install refused; installing anew"
	pnpm install --no-frozen-lockfile > "$tree.install.log" 2>&1
}
s=$(date +%s)
(cd packages/data/qti-database && node --disable-proto=delete --disable-sigusr1 "$tree/vendor/grizzle/packages/grizzle/src/cli/main.ts" \
	generate grizzle.config.ts --name "batch-$arm") > "$tree.generate.log" 2>&1
say "generate exit 0, $(($(date +%s) - s)) s: $(ls -d packages/data/qti-database/install/migrations/qti/*_batch-"$arm" | tail -n 1)"
