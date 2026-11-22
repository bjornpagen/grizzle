#!/usr/bin/env bash
# trunk's two test tiers in one cycle: the unit and types tier (pnpm test) and the network tier (pnpm test:network),
# both under the one seed the release gates on, run at the same time as two processes, so both tiers' reds are known
# after one cycle where the network tier waited for the unit tier to pass. The network tier reads the cluster, so
# `toolchain-pg settle` finishes before either starts; the unit tier reads none and needs no settle. Each tier's output
# is held apart and printed whole once both have ended, the unit tier's first, so trunk's log reads as two runs. The
# script exits non-zero when either tier does.
set -u
export TEST_SEED=2219874524
pnpm exec toolchain-pg settle || exit 1
held=$(mktemp -d)
trap 'rm -rf "$held"' EXIT
pnpm test > "$held/unit.log" 2>&1 &
unit=$!
pnpm test:network > "$held/network.log" 2>&1 &
network=$!
wait "$unit"
unitStatus=$?
wait "$network"
networkStatus=$?
echo "== pnpm test (test/unit test/types), exit $unitStatus"
cat "$held/unit.log"
echo "== pnpm test:network (test/pg test/schedules), exit $networkStatus"
cat "$held/network.log"
[ "$unitStatus" -eq 0 ] && [ "$networkStatus" -eq 0 ]
