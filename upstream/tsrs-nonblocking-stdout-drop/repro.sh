#!/bin/sh
# Shows tsrs dropping diagnostics when its standard output is a non-blocking pipe:
# `sh repro.sh <tsrs binary> [errors]`. It writes a project whose check reports exactly <errors> (default 4000) errors,
# then checks it three times with standard output set O_NONBLOCK, as a Node launcher that read process.stdout leaves
# the descriptor before execve, into a reader that starts a second late. A correct tsrs prints every error each time,
# as it does into a plain pipe; today the count falls short and varies. The exit status is 2 either way.
set -eu
tsrs="$1"
errors="${2:-4000}"
dir="$(mktemp -d)"
printf '{ "compilerOptions": { "strict": true, "noEmit": true, "types": [] }, "files": ["errors.ts"] }\n' > "$dir/tsconfig.json"
i=0
: > "$dir/errors.ts"
while [ "$i" -lt "$errors" ]; do
	printf 'export const value%d: number = "not a number %d"\n' "$i" "$i" >> "$dir/errors.ts"
	i=$((i + 1))
done
nonblocking() {
	python3 -c 'import fcntl, os, sys; flags = fcntl.fcntl(1, fcntl.F_GETFL); fcntl.fcntl(1, fcntl.F_SETFL, flags | os.O_NONBLOCK); os.execvp(sys.argv[1], sys.argv[1:])' "$@"
}
echo "plain pipe: $("$tsrs" --noEmit -p "$dir/tsconfig.json" | grep -c 'error TS' || true) of $errors"
for run in 1 2 3; do
	echo "non-blocking pipe, run $run: $(nonblocking "$tsrs" --noEmit -p "$dir/tsconfig.json" | (sleep 1; grep -c 'error TS' || true)) of $errors"
done
