#!/usr/bin/env bash
# pair.sh <out> <name-a> <tree-a> <family-a> <name-b> <tree-b> <family-b> [files...]: two network tiers at once (tier.sh),
# each on its own family, over the same files (every network file when none is named), at one TEST_SEED, so both meet
# the same machine load; their start and end in <out>/pair.start and <out>/pair.end.
set -u
: "${TEST_SEED:?the seed both tiers share}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out=$1
nameA=$2
treeA=$3
familyA=$4
nameB=$5
treeB=$6
familyB=$7
shift 7
mkdir -p "$out"
GRIZZLE_PG_CLUSTER=$familyA "$here/tier.sh" "$treeA" "$nameA" "$out" "$@" &
a=$!
GRIZZLE_PG_CLUSTER=$familyB "$here/tier.sh" "$treeB" "$nameB" "$out" "$@" &
b=$!
date -u +%FT%TZ >"$out/pair.start"
wait "$a" "$b"
date -u +%FT%TZ >"$out/pair.end"
