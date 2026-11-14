#!/usr/bin/env bash
# Puts the pinned PostgreSQL source at $GRIZZLE_PG_SRC, where grizzle's source patches are written, and a build
# directory for it, configured to install at $GRIZZLE_PG_PREFIX, at $GRIZZLE_PG_BUILD. build.sh runs it first; run it
# alone to work on a patch (CONTRIBUTING.md).
#
# The source is a git repository on the branch grizzle: the pinned release, PG_PIN_COMMIT, fetched alone from
# PostgreSQL's repository, then one commit for each PG_PIN_PATCHES entry, in order, the patch applied without fuzz and
# its own description the message. The tag upstream names the release and the tag pinned the commit of its last patch,
# so a new patch is a commit on top of pinned. The commits that hold the first of the pin's patches are kept, and the
# rest of the patches are committed on top of them. Nothing is lost: a change uncommitted, untracked or stashed, or a
# HEAD off grizzle, is refused, and so is any other commit on grizzle, unless it is one of the patches grizzle held when
# it was last made (pinned) and no branch or tag but these holds more. A refused repository is left as it is. After a
# repin it keeps nothing of the previous pin.
#
# The build directory is made anew on every run, so nothing of an earlier build is left in it, and nothing is ever
# built in the source.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"

repository=https://github.com/postgres/postgres.git
src="$GRIZZLE_PG_SRC"
git_src() { git -C "$src" "$@"; }
refuse() {
	printf '%s\n' "$@" "$src is left as it is." >&2
	exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [[ ! -e "$src/.git" ]]; then
	if [[ -e "$src" && -n "$(ls -A "$src")" ]]; then
		refuse "$src holds files but no git repository, so it is not the source this script makes; move it away."
	fi
	git init --quiet --initial-branch=grizzle "$src"
	git_src remote add origin "$repository"
fi

if [[ -n "$(git_src status --porcelain --untracked-files=all)" ]]; then
	refuse "$src has changes that are not committed:" "$(git_src status --short --untracked-files=all | head -20)" \
		"Commit them as a patch (CONTRIBUTING.md) or undo them."
fi
if [[ -n "$(git_src stash list)" ]]; then
	refuse "$src has stashed changes:" "$(git_src stash list)" "Commit them as a patch or drop them."
fi
if [[ "$(git_src symbolic-ref -q HEAD || true)" != refs/heads/grizzle ]]; then
	refuse "$src is not on its branch grizzle; check it out."
fi

# The release is verified by its commit's id, a hash over its whole tree, and the tag must name that commit.
if ! git_src cat-file -e "$PG_PIN_COMMIT^{commit}" 2>/dev/null; then
	git_src fetch --quiet --depth 1 --no-tags "$repository" "refs/tags/$PG_PIN_TAG"
	if [[ "$(git_src rev-parse 'FETCH_HEAD^{commit}')" != "$PG_PIN_COMMIT" ]]; then
		echo "$PG_PIN_TAG in $repository is not the pinned commit $PG_PIN_COMMIT" >&2
		exit 1
	fi
fi

# The tree after each of the pin's patches, each applied to the one before in an index of the script's own, starting
# from the release's. git apply allows no fuzz, and applies a patch whole or not at all. PostgreSQL's expected test
# outputs end lines in blanks, which it need not warn of.
index="$tmp/index"
GIT_INDEX_FILE="$index" git_src read-tree "$PG_PIN_COMMIT"
files=()
trees=()
for entry in $PG_PIN_PATCHES; do
	file="$here/patches/${entry%%=*}"
	echo "${entry#*=}  $file" | sha256sum -c -
	GIT_INDEX_FILE="$index" git_src apply --cached --whitespace=nowarn -p1 "$file"
	files+=("$file")
	trees+=("$(GIT_INDEX_FILE="$index" git_src write-tree)")
done

# The commits on grizzle after the release, oldest first, if it descends from the release without a merge, and how
# many of them, from the first, hold the pin's patches. Those are kept, and the rest of the patches are committed on
# top of the last of them.
descends=0
chain=()
if git_src merge-base --is-ancestor "$PG_PIN_COMMIT" grizzle 2>/dev/null &&
	[[ -z "$(git_src rev-list --merges "$PG_PIN_COMMIT..grizzle")" ]]; then
	descends=1
	mapfile -t chain < <(git_src rev-list --reverse "$PG_PIN_COMMIT..grizzle")
fi
held=0
while ((held < ${#chain[@]} && held < ${#trees[@]})) &&
	[[ "$(git_src rev-parse "${chain[held]}^{tree}")" == "${trees[held]}" ]]; do
	held=$((held + 1))
done
last_held="$PG_PIN_COMMIT"
((held == 0)) || last_held="${chain[held - 1]}"

# Commits after those are dropped only when they are among the patches grizzle held when it was last made, and so are
# in grizzle's history, and when no other ref holds work of its own.
tip="$last_held"
if ((!descends || held < ${#chain[@]})); then
	others="$(git_src for-each-ref --format='%(refname)' |
		grep -v -x -e refs/heads/grizzle -e refs/tags/upstream -e refs/tags/pinned -e 'refs/remotes/.*' || true)"
	if [[ -n "$others" ]]; then
		refuse "grizzle does not hold the pin's patches alone, and $src has refs this script did not make:" "$others" \
			"Carry their commits into scripts/pg/patches and PG_PIN_PATCHES (CONTRIBUTING.md), or delete them."
	fi
	current="$(git_src rev-parse -q --verify refs/heads/grizzle || true)"
	if [[ -n "$current" ]] && ! git_src merge-base --is-ancestor "$current" refs/tags/pinned 2>/dev/null; then
		refuse "grizzle has commits that are not among the pin's patches:" \
			"$(git_src log --oneline "$(git_src rev-parse -q --verify refs/tags/pinned || echo "$last_held")..grizzle")" \
			"Carry each into scripts/pg/patches and PG_PIN_PATCHES (CONTRIBUTING.md), or drop it."
	fi
fi

# The commits the script makes have one author and the release's date, so the same patches on the same release are
# always the same commits. A patch's message is its subject and body as git format-patch writes them, or the prose
# before its diff.
date="$(git_src log -1 --format=%cI "$PG_PIN_COMMIT")"
author=(GIT_AUTHOR_NAME="grizzle scripts/pg/source.sh" GIT_AUTHOR_EMAIL=scripts-pg@grizzle.invalid
	GIT_AUTHOR_DATE="$date" GIT_COMMITTER_NAME="grizzle scripts/pg/source.sh"
	GIT_COMMITTER_EMAIL=scripts-pg@grizzle.invalid GIT_COMMITTER_DATE="$date")
for ((i = held; i < ${#trees[@]}; i++)); do
	subject="$(git_src mailinfo "$tmp/message" /dev/null < "${files[i]}" | sed -n 's/^Subject: //p')"
	tip="$({ [[ -z "$subject" ]] || printf '%s\n\n' "$subject"; cat "$tmp/message"; } | git stripspace |
		env "${author[@]}" git -C "$src" commit-tree "${trees[i]}" -p "$tip")"
done

# git checkout keeps every change in the working tree; there is none.
if [[ "$tip" != "$(git_src rev-parse -q --verify refs/heads/grizzle || true)" ]]; then
	git_src checkout --quiet -B grizzle "$tip"
fi
previous="$(git_src rev-parse -q --verify 'refs/tags/upstream^{commit}' || true)"
git_src update-ref refs/tags/upstream "$PG_PIN_COMMIT"
git_src update-ref refs/tags/pinned "$tip"
if [[ -n "$previous" && "$previous" != "$PG_PIN_COMMIT" ]]; then
	git_src reflog expire --expire=now --all
	git_src gc --quiet --prune=now
fi
echo "PostgreSQL $PG_PIN_VERSION at $src: the release, tag upstream, and its patches to tag pinned, $(git_src rev-parse --short "$tip")"

# The libraries go to the prefix's lib, where pgvector's run path names them, not to the multiarch directory meson picks
# on Ubuntu. The regression suites run the build's temporary installation, whose programs and modules carry the
# prefix's lib as their run path, and the prefix holds the previous build or none. meson's test environment puts the
# temporary installation's library directory first on LD_LIBRARY_PATH, which every program pg_regress starts inherits,
# and the loader searches LD_LIBRARY_PATH before a RUNPATH, so the suites test this build alone. The link writes the run
# path as RUNPATH: an RPATH would come before LD_LIBRARY_PATH.
rm -rf "$GRIZZLE_PG_BUILD"
mkdir -p "$(dirname "$GRIZZLE_PG_BUILD")"
meson setup "$GRIZZLE_PG_BUILD" "$src" \
	--prefix="$GRIZZLE_PG_PREFIX" --libdir=lib \
	-Dc_link_args=-Wl,--enable-new-dtags \
	-Dllvm=disabled -Dssl=openssl -Dlz4=enabled -Dzstd=enabled -Dreadline=enabled \
	-Dicu=disabled -Ddocs=disabled -Dtap_tests=disabled -Dcassert=false
