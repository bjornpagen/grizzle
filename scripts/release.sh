#!/usr/bin/env bash
# The release check, one command from a checkout's root (`pnpm release`): both test tiers at once under the one seed the
# release gates on, each a systemd unit of its own in priority.slice, the slice of the one job others wait on (its CPU
# weight above every other slice's). The unit and types tier (pnpm test) starts at once: it reads no cluster. The
# database tier (pnpm test:network) settles the checkout's cluster family first (toolchain-pg settle), then runs; it
# spends its time waiting on the cluster, so starting the two together costs the unit tier almost no CPU.
#
# Each tier's unit writes its output to a file of its own, never through the journal, which drops lines under the test
# servers' logging: ${XDG_STATE_HOME:-~/.local/state}/grizzle-release/<key>/<UTC start>/<tier>.log. The check follows
# each file, printing every line as it lands after its tier's name, reads each tier's exit from systemd (systemd-run
# --wait answers its unit's; a oneshot unit, so a tier stopped or killed from outside fails, where a plain service would
# count a stop's SIGTERM as a clean exit), and ends with each tier's exit, wall time and summary line. It exits 1 when
# either tier fails. The units are grizzle-release-<key>-unit and grizzle-release-<key>-database, <key> the first 8 hex digits of
# the SHA-256 of the checkout's real path, so a check already running in a checkout is refused by its name and checks in
# two checkouts run apart; stopping the check (an interrupt) stops both units.
set -u
seed=2219874524
root=$(pwd -P)
key=$(printf %s "$root" | sha256sum | cut -c1-8)
logs="${XDG_STATE_HOME:-$HOME/.local/state}/grizzle-release/$key/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$logs"
units=("grizzle-release-$key-unit" "grizzle-release-$key-database")
trap 'systemctl --user stop "${units[@]}" 2>/dev/null; exit 130' INT TERM

# tier <name> <command...>: the command as the tier's unit, its output in <name>.log, each line printed after the
# tier's name as it lands; then the tier's exit and wall time, written to <name>.exit, and its status returned.
tier() {
	local name=$1
	shift
	local log="$logs/$name.log"
	: > "$log"
	local began=${EPOCHREALTIME/./}
	systemd-run --user --quiet --wait --collect --slice=priority.slice -u "grizzle-release-$key-$name" -p Type=oneshot \
		--working-directory="$root" -E TEST_SEED=$seed \
		-p StandardOutput="append:$log" -p StandardError="append:$log" -- "$@" < /dev/null &
	local waiter=$!
	tail -n +1 -F --pid="$waiter" "$log" 2> /dev/null | sed -u "s/^/$name | /" &
	local follower=$!
	wait "$waiter"
	local status=$?
	local wall=$(((${EPOCHREALTIME/./} - began) / 1000))
	wait "$follower"
	echo "exit $status, wall $((wall / 1000)).$(printf %03d $((wall % 1000))) s" > "$logs/$name.exit"
	echo "$name | $(cat "$logs/$name.exit")"
	return "$status"
}

echo "release check of $root at TEST_SEED=$seed, each tier's output in $logs"
tier unit pnpm -s test &
unit=$!
tier database sh -c 'pnpm -s exec toolchain-pg settle && pnpm -s test:network' &
database=$!
wait "$unit"
unitStatus=$?
wait "$database"
databaseStatus=$?
for name in unit database; do
	summary=$(grep -E '^[0-9]+ properties' "$logs/$name.log" | tail -n 1)
	echo "release check, $name tier: $(cat "$logs/$name.exit"); ${summary:-no summary line: it ended before its runner summarized}"
done
[ "$unitStatus" -eq 0 ] && [ "$databaseStatus" -eq 0 ]
