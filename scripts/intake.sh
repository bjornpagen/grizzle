#!/usr/bin/env bash
# The train intake, one command from a checkout's root, before a train is assembled: `scripts/intake.sh <commit>...`.
# A car joins a train only once `pnpm check` passes at its own commit (main's ruling, 2026-11-26): train C's check met
# lint, format and type errors in five of the six cars that had joined it since train B, each sent on the types
# daemon's verdict alone, so the train's gate met them. The intake runs that check, every car at once, before a train is
# assembled. Each commit is checked out in a tree of its own, a detached git worktree at
# ${XDG_CACHE_HOME:-~/.cache}/<repository>-intake/<commit>, with its toolchain submodule and its dependencies installed
# offline. `pnpm check` runs there as a systemd unit of its own in the repository's slice, <repository>-intake-<the
# commit's first 12 hex digits>, so a commit whose intake is already running is refused by name: Type=exec, active while
# its check runs, never a start job the manager holds for the check's whole run (a oneshot's start job sat "running" for
# 40 minutes on 2026-11-26), and a pass is the check's own summary, every task successful, beside its exit. Every tree shares one
# turbo cache (TURBO_CACHE_DIR), so a package that no car changes is checked once. Each check writes its output to
# ${XDG_STATE_HOME:-~/.local/state}/<repository>-intake/<UTC start>/<commit>.log. As each verdict lands, the intake
# prints it: pass, or FAIL followed by every line of each failed task, to send back to the car's owner. It removes each
# tree once its check ends and keeps the log. It exits 1 when any commit fails.
set -u
(($# > 0)) || {
	echo "usage: scripts/intake.sh <commit>..." >&2
	exit 2
}
common=$(git rev-parse --path-format=absolute --git-common-dir)
repository=$(basename "$(dirname "$common")")
trees="${XDG_CACHE_HOME:-$HOME/.cache}/$repository-intake"
logs="${XDG_STATE_HOME:-$HOME/.local/state}/$repository-intake/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$trees/turbo" "$logs"
commits=()
for revision in "$@"; do
	commit=$(git rev-parse --verify --quiet "$revision^{commit}") || {
		echo "intake: $revision names no commit" >&2
		exit 2
	}
	commits+=("$commit")
done
units=()
for commit in "${commits[@]}"; do
	units+=("$repository-intake-${commit:0:12}")
done
trap 'systemctl --user stop "${units[@]}" 2>/dev/null; exit 130' INT TERM

# failures <log>: every line each task the check's summary names as failed wrote, under the task's name; turbo prefixes
# a task's lines with its id, `#` read as `:` (`//#oxlint` writes `//:oxlint: `).
failures() {
	local log=$1
	local failed
	failed=$(sed -n 's/^Failed: *//p' "$log" | tr -d ' ' | tr ',' '\n')
	if [ -z "$failed" ]; then
		echo "  no task failed: the check itself did not finish (its log: $log)"
		tail -n 20 "$log" | sed 's/^/  /'
		return
	fi
	while read -r task; do
		echo "  $task"
		grep -F -- "${task/\#/:}: " "$log" |
			grep -v -E ': (cache (miss|hit|bypass)|\$ |Progress: |\[ELIFECYCLE\])' |
			sed "s|^${task/\#/:}: |    |"
	done <<< "$failed"
}

# intake <commit>: the commit checked in a tree of its own, its verdict printed, its status returned.
intake() {
	local commit=$1
	local tree="$trees/$commit"
	local log="$logs/$commit.log"
	local began=${EPOCHREALTIME/./}
	# a tree an intake cut short left behind is removed first, so a commit's intake always starts from its commit
	git worktree remove --force "$tree" > /dev/null 2>&1 || rm -rf "$tree"
	git worktree prune
	git worktree add --quiet --detach --force "$tree" "$commit" > "$log" 2>&1 &&
		git -C "$tree" submodule --quiet update --init >> "$log" 2>&1 &&
		(cd "$tree" && pnpm install --frozen-lockfile --offline --silent) >> "$log" 2>&1 &&
		systemd-run --user --quiet --wait --collect --slice="$repository.slice" -u "$repository-intake-${commit:0:12}" \
			-p Type=exec --working-directory="$tree" -E TURBO_CACHE_DIR="$trees/turbo" \
			${TMPDIR:+-E TMPDIR="$TMPDIR"} ${TOOLCHAIN_CPU_ALLOWANCE:+-E TOOLCHAIN_CPU_ALLOWANCE="$TOOLCHAIN_CPU_ALLOWANCE"} \
			-p StandardOutput="append:$log" -p StandardError="append:$log" -- pnpm check < /dev/null
	local status=$?
	# A check passes only on its summary's word: every task successful. A unit stopped from outside (its main process
	# ended by SIGTERM, which a Type=exec unit counts as a clean exit) or a check cut short writes no such summary.
	if [ "$status" -eq 0 ] && ! awk '$1 == "Tasks:" && $3 == "successful," && $2 == $4 { whole = 1 } END { exit !whole }' "$log"; then
		status=1
	fi
	git worktree remove --force "$tree" >> "$log" 2>&1
	local wall=$(((${EPOCHREALTIME/./} - began) / 1000000))
	local subject
	subject=$(git log -1 --format=%s "$commit" | cut -c1-100)
	if [ "$status" -eq 0 ]; then
		echo "pass $commit (${wall} s) $subject"
	else
		echo "FAIL $commit (${wall} s, exit $status) $subject"
		failures "$log"
	fi
	return "$status"
}

echo "intake of ${#commits[@]} commits of $repository, pnpm check at each, every log in $logs"
declare -A of
for commit in "${commits[@]}"; do
	intake "$commit" > "$logs/$commit.verdict" &
	of[$!]=$commit
done
failed=0
for _ in "${commits[@]}"; do
	wait -n -p landed
	status=$?
	cat "$logs/${of[$landed]}.verdict"
	[ "$status" -eq 0 ] || failed=1
done
exit "$failed"
