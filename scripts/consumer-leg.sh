#!/usr/bin/env bash
# The train's consumer leg, from a checkout's root, at a train's tip before it lands:
#   scripts/consumer-leg.sh <grizzle commit> <consumer>@<consumer commit or trunk>|<consumer>=<car checkout>...
# Every train gate runs it beside its tiers (main's ruling, 2026-11-26): train B landed on main and broke qti-pie's
# pantry generate, an internal compiler error grizzle's own suite never met (write/insert/stamp.ts stampedInput, "a
# public heading of 1 columns, not 0", edullm's Q15), so a landing is held to its consumers' generate as to its tests.
# Each consumer is a fresh clone of its local hub at the commit named (~/.cache/grizzle-release/bin/consumer-copy.sh
# --from-hub), or a copy of a car's checkout, a commit no hub holds (metis's joint pin, consumer-cars.txt), its
# dependencies installed offline, kept as the pristine copy of that commit and copied again for each
# run by reflink (never hardlinks). The grizzle commit's tree (a detached worktree, its toolchain submodule beside it)
# is laid over the copy's vendored grizzle, the copy checked current (consumer-check.sh), and `grizzle generate` run for
# each of the consumer's configs (CONSUMERS below), each a fresh draft, every migrations folder beside it set aside, so
# no snapshot of another format is read. Each consumer's generates run as one systemd unit of their own in
# grizzle.slice, grizzle-consumer-leg-<consumer>-<the commit's first 8 hex digits>, Type=exec and MemoryMax=24G, the
# consumers at once; each config's verdict prints as its consumer's unit ends: pass, or FAIL and the end of its log.
# Logs: ${XDG_STATE_HOME:-~/.local/state}/grizzle-consumer-leg/<UTC start>/. It exits 1 when any config fails.
set -u
usage() {
	echo "usage: scripts/consumer-leg.sh <grizzle commit> <consumer>@<commit or trunk>|<consumer>=<car checkout>..." >&2
	exit 2
}
(($# > 1)) || usage
commit=$(git rev-parse --verify --quiet "$1^{commit}") || {
	echo "consumer-leg: $1 names no commit" >&2
	exit 2
}
shift
bin="$HOME/.cache/grizzle-release/bin"
hubs="$HOME/.local/var/hub"
base="${XDG_CACHE_HOME:-$HOME/.cache}/grizzle-consumer-leg"
logs="${XDG_STATE_HOME:-$HOME/.local/state}/grizzle-consumer-leg/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$base/pristine" "$base/runs" "$logs"

# CONSUMERS: each consumer's vendored grizzle, then the configs a train generates of it (main's list: qti-pie's pantry
# and its ledger's result composition; metis's generate configs, the qti-pie and den it vendors among them).
consumer_of() {
	case $1 in
	qti-pie) echo "vendor/grizzle packages/pantry/grizzle.config.ts packages/ledger/grizzle.result.config.ts" ;;
	metis) echo "vendor/grizzle packages/database/grizzle.config.ts packages/key-entry/grader/grizzle.config.ts packages/database/integration/suite/grizzle.config.ts vendor/den/packages/den/integration/slice/grizzle.config.ts vendor/qti-pie/packages/pantry/grizzle.config.ts vendor/qti-pie/packages/ledger/grizzle.result.config.ts" ;;
	*) return 1 ;;
	esac
}

# The grizzle commit's tree, once for every consumer: a detached worktree with its toolchain submodule.
tree="$base/grizzle-$commit"
if [ ! -d "$tree" ]; then
	git worktree add --quiet --detach --force "$tree" "$commit" > "$logs/grizzle.log" 2>&1 &&
		git -C "$tree" submodule --quiet update --init >> "$logs/grizzle.log" 2>&1 || {
		echo "consumer-leg: the tree of $commit could not be made: $(tail -3 "$logs/grizzle.log")" >&2
		exit 1
	}
fi

# leg <consumer> <commit>: the consumer's run copy made, the tree laid over it, checked, and each config generated, as
# the consumer's unit; its verdicts printed; its status returned.
leg() {
	local consumer=$1 rev=$2 specs vendored configs sha pristine work unit
	specs=$(consumer_of "$consumer") || {
		echo "FAIL $consumer: no configs are named for it (consumer-leg.sh CONSUMERS)"
		return 1
	}
	read -r vendored configs <<< "$specs"
	local from=(--from-hub "$consumer")
	if [ -d "$rev" ]; then
		sha=$(git -C "$rev" rev-parse --verify --quiet HEAD) || {
			echo "FAIL $consumer: $rev is no checkout"
			return 1
		}
		from=("$rev")
	else
		if [ "$rev" = trunk ]; then rev=HEAD; fi
		sha=$(git -C "$hubs/$consumer.git" rev-parse --verify --quiet "$rev^{commit}") || {
			echo "FAIL $consumer: $rev names no commit of its hub"
			return 1
		}
		from+=("$sha")
	fi
	pristine="$base/pristine/$consumer-$sha"
	if [ ! -d "$pristine" ]; then
		# made beside it and renamed into place whole, so a copy cut short is never taken for a pristine one
		local making="$pristine.making-$$"
		rm -rf "$making"
		if ! { "$bin/consumer-copy.sh" "${from[@]}" "$making" > "$logs/$consumer-copy.log" 2>&1 &&
			(cd "$making" && pnpm install --frozen-lockfile --offline --silent) >> "$logs/$consumer-copy.log" 2>&1; }; then
			rm -rf "$making"
			echo "FAIL $consumer@$sha: its copy could not be made: $(tail -3 "$logs/$consumer-copy.log")"
			return 1
		fi
		mv -T "$making" "$pristine" 2> /dev/null || rm -rf "$making"
	fi
	work="$base/runs/$(basename "$logs")-$consumer"
	cp -a --reflink=auto "$pristine" "$work"
	unit="grizzle-consumer-leg-$consumer-${commit:0:8}"
	# shellcheck disable=SC2016 # the script reaches the unit's shell as its text, its arguments as $1 and on
	systemd-run --user --quiet --wait --collect --slice=grizzle.slice -u "$unit" -p Type=exec -p MemoryMax=24G \
		--working-directory="$work" -E PATH="$PATH" ${TMPDIR:+-E TMPDIR="$TMPDIR"} \
		-p StandardOutput="append:$logs/$consumer.log" -p StandardError="append:$logs/$consumer.log" -- \
		/bin/bash -c '
			set -u
			tree=$1 vendored=$2 logs=$3 consumer=$4 commit=$5 check=$6
			root=$PWD
			shift 6
			rsync -a --delete --exclude=node_modules --exclude=.jj --exclude=.git "$tree/" "$vendored/" || exit 3
			echo "edits=$vendored = grizzle $commit; migrations folders beside each config set aside (fresh draft)" >> .consumer-provenance
			"$check" . || exit 4
			failed=0
			for config in "$@"; do
				dir=$(dirname "$config")
				label=$(echo "$config" | tr / _)
				find "$dir" -maxdepth 5 -name node_modules -prune -o -name snapshot.json -print | while read -r snapshot; do
					folder=$(dirname "$snapshot")
					mkdir -p .leg-aside && mv "$folder" ".leg-aside/$(echo "$folder" | tr / _)"
				done
				mkdir -p "$logs/xdg-$consumer-$label"
				(cd "$dir" && XDG_CACHE_HOME="$logs/xdg-$consumer-$label" node --disable-proto=delete \
					"$root/$vendored/packages/grizzle/src/cli/bin.ts" generate "$(basename "$config")" --name leg) \
					> "$logs/gen-$consumer-$label.log" 2>&1
				status=$?
				echo "$config: exit $status" >> "$logs/$consumer.verdicts"
				[ "$status" -eq 0 ] || failed=1
			done
			exit "$failed"
		' leg "$tree" "$vendored" "$logs" "$consumer" "$commit" "$bin/consumer-check.sh" $configs < /dev/null # configs split by design
	local status=$?
	local config label
	for config in $configs; do
		label=$(echo "$config" | tr / _)
		if grep -q -F -x "$config: exit 0" "$logs/$consumer.verdicts" 2> /dev/null; then
			echo "pass $consumer@${sha:0:12} $config"
		else
			echo "FAIL $consumer@${sha:0:12} $config"
			tail -n 15 "$logs/gen-$consumer-$label.log" 2> /dev/null | sed 's/^/    /'
		fi
	done
	[ "$status" -eq 0 ] || tail -n 5 "$logs/$consumer.log" | sed 's/^/  unit: /'
	return "$status"
}

echo "consumer leg of grizzle $commit over $*, every log in $logs"
declare -A of
for spec in "$@"; do
	case $spec in
	*=*) consumer=${spec%%=*} rev=${spec#*=} ;;
	*@*) consumer=${spec%@*} rev=${spec#*@} ;;
	*) usage ;;
	esac
	leg "$consumer" "$rev" > "$logs/$consumer.out" &
	of[$!]=$consumer
done
failed=0
for _ in "$@"; do
	wait -n -p landed
	status=$?
	cat "$logs/${of[$landed]}.out"
	[ "$status" -eq 0 ] || failed=1
done
exit "$failed"
