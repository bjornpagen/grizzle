#!/usr/bin/env bash
# A replay set, from a checkout's root: `scripts/replay-set.sh <tokens file> [<tsv>]`. Each line of the file is one
# replay token as a failure prints it (`<test module>#<property>:<seed part>:<case path>`, the text inside
# `toolchain-test replay '…'`); each is replayed as its own process, `toolchain-test replay <token>`, one after another,
# so no token is ever an argument of another's command and a token that did not run cannot read as one that passed.
# For each token the TSV (default <logs>/replays.tsv) records the checkout's HEAD and its `git status --short` line count
# read just before the replay, the replay's exit code, and its log, ${XDG_STATE_HOME:-~/.local/state}/grizzle-replays/
# <UTC start>/<n>.log; a replay run where HEAD moved or the tree was dirty is refused before it runs (exit 3 in its
# row), so every verdict names the one tree it was judged at. Run it as a unit of its own in a workspace no gate is
# using. It prints the TSV's path and exits 1 when any replay failed or was refused.
set -u
tokens=${1:?usage: scripts/replay-set.sh <tokens file> [<tsv>]}
logs="${XDG_STATE_HOME:-$HOME/.local/state}/grizzle-replays/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$logs"
tsv=${2:-$logs/replays.tsv}
head=$(git rev-parse HEAD)
printf "token\thead\tdirty\texit\tlog\n" > "$tsv"
failed=0
n=0
while IFS= read -r token || [ -n "$token" ]; do
	[ -n "$token" ] || continue
	n=$((n + 1))
	log="$logs/$n.log"
	now=$(git rev-parse HEAD)
	dirty=$(git status --short | wc -l)
	if [ "$now" != "$head" ] || [ "$dirty" -ne 0 ]; then
		status=3
		echo "refused: HEAD $now (was $head), $dirty paths dirty" > "$log"
	else
		toolchain-test replay "$token" > "$log" 2>&1 < /dev/null
		status=$?
	fi
	printf "%s\t%s\t%s\t%s\t%s\n" "$token" "$now" "$dirty" "$status" "$log" >> "$tsv"
	[ "$status" -eq 0 ] || failed=1
done < "$tokens"
echo "$tsv"
exit "$failed"
