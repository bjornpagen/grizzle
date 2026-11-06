#!/bin/sh
# The pre-commit gate checks exactly what the commit holds. The index is mirrored into a cache directory with an
# empty git repository of its own, where what .gitignore names (node_modules, TypeScript's build info and declaration
# output, the tools' caches) persists between commits, and `pnpm check` runs there: work in progress elsewhere in the
# working tree neither fails nor passes it.
set -eu
root=$(git rev-parse --show-toplevel)
gate="${XDG_CACHE_HOME:-$HOME/.cache}/grizzle-check/$(printf '%s' "$root" | shasum | cut -c1-12)"
staged="$gate.index"
rm -rf "$staged"
git checkout-index --all --prefix="$staged/"
mkdir -p "$gate"
rsync -a --checksum --delete --exclude /.git --filter=':- .gitignore' "$staged/" "$gate/"
rm -rf "$staged"
cd "$gate"
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
[ -d .git ] || git init --quiet
pnpm install --frozen-lockfile --offline --reporter=silent
exec pnpm check
