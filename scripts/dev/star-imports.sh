#!/usr/bin/env bash
# The codemod that brings a repository's code to grizzle's star imports and PostgreSQL's names, in two passes of the
# repository's own oxlint with --fix over the paths it is given:
#
# 1. the dev tools' grizzle-star-imports rule (`@bjornpagen/devtools`, the repository's own), whose fix makes each
#    module's imports of a grizzle entry one namespace import under the entry's name, `import * as g from
#    "@bjornpagen/grizzle"`, `import * as gRuntime from "@bjornpagen/grizzle/runtime"` (`import type * as …` where every
#    name was a type), and reads each use of an imported name off it, `x` becoming `g.x`, every entry of a module in one
#    run;
# 2. the rule beside this script (star-imports-plugin.ts), which renames each name read off an entry's namespace to the
#    one it has: PostgreSQL's plain types by their pg_type names (`g.pg.integer` is `g.int4`, `g.pg["double precision"]`
#    `g.float8`), bytea, range, bit, domain and their companions, Text.parseFloat8 and Text.parseNumeric, and every SQL
#    tag among a namespace type's arguments by its typname (`g.Term<D, unknown, O, "bigint">` is `"int8"`).
#
# A module whose name for an entry is taken, a re-export of an entry and a read of a pg namespace that names no member of
# it are reported and left as they are, for their authors. From the repository's root, after moving vendor/grizzle and
# vendor/toolchain to the pin:
#
#   pnpm exec bash vendor/grizzle/scripts/dev/star-imports.sh <paths…>
#
# then the typecheck, which names whatever the two passes left, and the formatter on the files they changed. It reads the
# repository's own oxlint, node, dev tools and effect, which the rename plugin imports from the repository's root; a pass
# whose plugin oxlint cannot load stops it, saying so. A vendored repository is no path's: each is its own repository's
# to run this over.
set -euo pipefail

if [ "$#" -eq 0 ]; then
	echo "Name the paths to rewrite: pnpm exec bash vendor/grizzle/scripts/dev/star-imports.sh <paths…>" >&2
	exit 2
fi
command -v oxlint >/dev/null || {
	echo "star-imports: no oxlint on PATH; run it from the repository's root under pnpm exec" >&2
	exit 2
}

names="$(cd -- "$(dirname -- "$0")" && pwd)/star-imports-plugin.ts"
imports=$(node --input-type=module -e 'process.stdout.write((await import("@bjornpagen/devtools/preset")).PLUGIN_MODULE)')
scratch=$(mktemp -d "${TMPDIR:-/tmp}/star-imports-XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT

# One pass: oxlint with --fix over the paths, every built-in category off so it runs the one rule of the one plugin. It
# exits 0 where nothing is left reported and 1 where something is, each report a `file:line:column: message
# [Error/rule]` line; a configuration or plugin oxlint could not load exits 1 with no report at all, which stops the
# codemod.
pass() {
	local name=$1 plugin=$2 rule=$3 status=0 output
	shift 3
	printf '{"plugins":[],"categories":{"correctness":"off","nursery":"off","pedantic":"off","perf":"off","restriction":"off","style":"off","suspicious":"off"},"jsPlugins":["%s"],"ignorePatterns":["**/vendor/**"],"rules":{"%s":"error"}}\n' \
		"$plugin" "$rule" >"$scratch/$name.json"
	output=$(oxlint -c "$scratch/$name.json" --format=unix --fix "$@") || status=$?
	if [ "$status" -ne 0 ] && ! grep -qE '^[^:]+:[0-9]+:[0-9]+: .*\[Error/[^]]+\]$' <<<"$output"; then
		printf 'star-imports: the %s pass did not run:\n%s\n' "$name" "$output" >&2
		exit 1
	fi
	printf '%s\n' "$output"
}

pass imports "$imports" devtools/grizzle-star-imports "$@"
pass names "$names" grizzle-names/rename "$@"
echo "star-imports: imports and names rewritten where they could be, and the rest reported above; run the typecheck, then the formatter on the files changed"
