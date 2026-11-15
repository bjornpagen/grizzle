#!/usr/bin/env bash
# REPIN: the two edullm trees the arms run, for a port.sh output directory.
#   $W/base:    <edullm rev> as committed, its own submodules (the production chain's grizzle), installed.
#   $W/runport: a fresh clone of <edullm rev> with edullm-repin.diff applied by `git apply --index`, as push-db would
#               apply it, its submodules at the diff's gitlinks, installed: proof the diff applies whole.
# Usage: trees.sh <port.sh out dir>
set -euo pipefail
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
out=$(readlink -f "$1")
R=$(cat "$out/edullm-rev.txt")
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
[ -d "$W/base/.git" ] || git clone -q --reference "$W/edullm" https://github.com/primer-team/edullm.git "$W/base"
cd "$W/base"
git fetch -q origin
git rev-parse -q --verify "$R^{commit}" > /dev/null || git fetch -q "$HOME/Documents/edullm" "$R"
git checkout -q -f "$R"
git clean -fdq -e .agents
git submodule update --init -q --reference "$HOME/Documents/grizzle" vendor/grizzle
git submodule update --init -q --reference "$HOME/Documents/grizzle/vendor/toolchain" vendor/toolchain
pnpm install --frozen-lockfile > "$out/install-base.log" 2>&1
echo "base $(git rev-parse --short HEAD): $(git submodule status | tr -s ' ' | cut -d' ' -f2-3 | tr '\n' ' ')" | tee "$out/trees.txt"
rm -rf "$W/runport"
git clone -q "$W/base" "$W/runport"
cd "$W/runport"
git checkout -q "$R"
git apply --index "$out/edullm-repin.diff"
git submodule update --init -q --reference "$HOME/Documents/grizzle" vendor/grizzle
git submodule update --init -q --reference "$HOME/Documents/grizzle/vendor/toolchain" vendor/toolchain
pnpm install --frozen-lockfile > "$out/install-runport.log" 2>&1
echo "runport $(git rev-parse --short HEAD) + edullm-repin.diff ($(git diff --cached --shortstat)): $(git submodule status | tr -s ' ' | cut -d' ' -f2-3 | tr '\n' ' ')" | tee -a "$out/trees.txt"
