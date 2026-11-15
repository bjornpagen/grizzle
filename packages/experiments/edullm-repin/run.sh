#!/usr/bin/env bash
# REPIN, one command: edullm's repin onto grizzle <grizzle rev> drafted, checked and proven on two production-shaped
# 19rc1 clusters. port.sh (the port tree, the drafts, the checks, the diff, the shape), trees.sh (the base and run
# trees), then finish.sh (the arms, the shape report with the locks seen, each local migrate's cost). Everything lands in
# $W/out/<grizzle short>/. After a failure in the arms, `finish.sh $W/out/<grizzle short>` reruns them alone.
# Usage: run.sh <grizzle rev> [<edullm rev>] [<base port> <repin port>]
set -euo pipefail
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
bash "$S/port.sh" "$1" "${2:-origin/staging}"
G=$(git -C "$W/edullm/vendor/grizzle" rev-parse HEAD)
out="$W/out/${G:0:8}"
bash "$S/trees.sh" "$out"
bash "$S/finish.sh" "$out" "${3:-47311}" "${4:-47312}"
