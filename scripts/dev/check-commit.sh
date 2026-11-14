#!/bin/sh
# Runs `pnpm check` on exactly what the index holds, on demand. The index is mirrored into a cache directory with an
# empty git repository of its own, where what .gitignore names (node_modules, TypeScript's build info and declaration
# output, the tools' caches) persists between runs, and `pnpm check` runs there: work in progress elsewhere in the
# working tree neither fails nor passes it. git checkout-index writes files alone and skips a gitlink, so each
# submodule the index pins (vendor/toolchain) is written from its own repository at the commit the index names.
set -eu
root=$(git rev-parse --show-toplevel)
gate="${XDG_CACHE_HOME:-$HOME/.cache}/grizzle-check/$(printf '%s' "$root" | shasum | cut -c1-12)"
staged="$gate.index"
rm -rf "$staged"
git checkout-index --all --prefix="$staged/"
gitlinks=$(git ls-files --stage | awk '$1 == "160000" { print $2 " " $4 }')
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
printf '%s\n' "$gitlinks" | while read -r commit path; do
	[ -n "$commit" ] || continue
	git -C "$root/$path" cat-file -e "$commit^{commit}"
	mkdir -p "$staged/$path"
	git -C "$root/$path" archive "$commit" | tar -x -C "$staged/$path"
done
mkdir -p "$gate"
rsync -a --checksum --delete --exclude /.git --filter=':- .gitignore' "$staged/" "$gate/"
rm -rf "$staged"
cd "$gate"
[ -d .git ] || git init --quiet
pnpm install --frozen-lockfile --offline --reporter=silent
exec pnpm check
