# The push's gate: `pnpm check` on HEAD's snapshot (toolchain-gate run, vendor/toolchain/packages/devtools/bin/gate.sh),
# the full gate over what the push sends, what a merge or rebase brought that pre-commit never saw among it. It is a script job because lefthook runs a script job
# whatever files the push changes, while it skips a pre-push run job whenever `git diff HEAD @{push}` names no file, as a
# push of the toolchain's gitlink alone, of deletions alone or of an empty commit does, so each of those went out
# ungated.
#
# Its arguments are git's pre-push arguments, which lefthook passes on: the remote's name (its URL when the push names
# none) and its URL; by hand it takes none. Anything else is refused, since this script checks HEAD whatever it is
# given: lanes told to run `.lefthook/pre-push/gate.sh run index …` were checking HEAD, not the index. The index's check
# is the toolchain's gate itself: `sh vendor/toolchain/packages/devtools/bin/gate.sh run index pnpm check`.
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || { [ "$1" != "$2" ] && ! git remote get-url -- "$1" >/dev/null 2>&1; }; }; then
	printf 'pre-push gate: takes git'"'"'s pre-push arguments (a remote and its URL) or none, and checks HEAD; to run a check on the index or a commit, run sh vendor/toolchain/packages/devtools/bin/gate.sh run <index|commit> <command>\n' >&2
	exit 2
fi
exec sh vendor/toolchain/packages/devtools/bin/gate.sh run HEAD pnpm -s check --output-logs=errors-only
