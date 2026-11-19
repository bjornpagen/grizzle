# The push's gate: `pnpm check` on HEAD's snapshot (toolchain-gate run, vendor/toolchain/packages/devtools/bin/gate.sh),
# the full gate over what the push sends, what a merge or rebase brought that pre-commit never saw among it. It is a script job because lefthook runs a script job
# whatever files the push changes, while it skips a pre-push run job whenever `git diff HEAD @{push}` names no file, as a
# push of the toolchain's gitlink alone, of deletions alone or of an empty commit does, so each of those went out
# ungated.
exec sh vendor/toolchain/packages/devtools/bin/gate.sh run HEAD pnpm -s check --output-logs=errors-only
