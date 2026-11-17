# The push gate (toolchain-gate push, vendor/toolchain/packages/devtools/bin/gate.sh) on each commit the push sends,
# which git names on the hook's stdin (lefthook.yml's use_stdin). It is a script job because lefthook runs a script job
# whatever files the push changes, while it skips a pre-push run job whenever `git diff HEAD @{push}` names no file, as
# a push of a submodule's gitlink alone, of deletions alone or of an empty commit does, so each of those went out
# ungated.
exec sh vendor/toolchain/packages/devtools/bin/gate.sh push
