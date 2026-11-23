#!/usr/bin/env bash
# The release check, one command from a checkout's root (`pnpm release`): both test tiers at once under the one seed the
# release gates on, each a systemd unit of its own in priority.slice, the slice of the one job others wait on (its CPU
# weight above every other slice's). The unit and types tier (pnpm test) starts at once: it reads no cluster. The
# database tier (pnpm test:network) settles the checkout's cluster family first (toolchain-pg settle), then runs; it
# spends its time waiting on the cluster, so starting the two together costs the unit tier almost no CPU. Each tier's
# lines are printed as they land, each after its tier's name, and each tier's verdict and wall time when it ends. The
# check exits 1 when either tier fails. Its units are grizzle-release-<key>-unit and grizzle-release-<key>-database,
# <key> the first 8 hex digits of the SHA-256 of the checkout's real path, so a check already running in a checkout is
# refused by its name and checks in two checkouts run apart; stopping the check (an interrupt) stops both units.
set -u
seed=2219874524
root=$(pwd -P)
key=$(printf %s "$root" | sha256sum | cut -c1-8)
units=("grizzle-release-$key-unit" "grizzle-release-$key-database")
trap 'systemctl --user stop "${units[@]}" 2>/dev/null; exit 130' INT TERM

# tier <name> <command...>: the command as the tier's unit, its lines after its name as they land, then its verdict.
tier() {
	local name=$1
	shift
	local began
	began=$(date +%s%3N)
	systemd-run --user --quiet --wait --pipe --collect --slice=priority.slice -u "grizzle-release-$key-$name" \
		--working-directory="$root" -E TEST_SEED=$seed -- "$@" < /dev/null 2>&1 | sed -u "s/^/$name | /"
	local status=${PIPESTATUS[0]}
	local wall=$(($(date +%s%3N) - began))
	echo "$name | exit $status, wall $((wall / 1000)).$(printf %03d $((wall % 1000))) s"
	return "$status"
}

echo "release check of $root at TEST_SEED=$seed"
tier unit pnpm -s test &
unit=$!
tier database sh -c 'pnpm -s exec toolchain-pg settle && pnpm -s test:network' &
database=$!
wait "$unit"
unitStatus=$?
wait "$database"
databaseStatus=$?
echo "release check: unit tier exit $unitStatus, database tier exit $databaseStatus"
[ "$unitStatus" -eq 0 ] && [ "$databaseStatus" -eq 0 ]
