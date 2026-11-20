#!/usr/bin/env bash
# Builds the pinned PostgreSQL release and pgvector natively, and installs the build at $GRIZZLE_PG_PREFIX. A prefix
# that already holds the pinned release is kept unless --force is given.
#
# The source is the one source.sh extracts at $GRIZZLE_PG_SRC from the release's verified tarball, and the build is made
# in $GRIZZLE_PG_BUILD beside the prefix, which source.sh makes anew, so nothing is built in the source. The prefix
# holds a complete build, or the build it held before, and never anything in between. Every input is fetched first.
# PostgreSQL's regression suites must pass before the build is installed into a staging tree beside the prefix, on the
# same file system; pgvector is checked out and built into that tree and the stamp is written last. Only then does one
# rename exchange the tree with the prefix. A failure before the exchange leaves the prefix as it was, and the staging
# tree, which holds the previous build after the exchange, is removed on every exit.
#
# Unless --force is given, the exchange is refused while any postmaster runs from the prefix, since it would replace
# that postmaster's binaries under it: before anything changes, and again just before the exchange, since a cluster may
# start while the build runs. Stop each cluster first (`pnpm pg stop`).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/pin.env"

# pg_node <module> [args...]: runs the module <module> of packages/pg/src from the repository's root, the package the
# installing workspace links, whose own node_modules hold what its modules import, so a checkout taken as a submodule
# runs this script from its consumer's install and never needs an install of its own.
repo_root="$(cd "$here/../.." && pwd)"
pg_node() {
	local module=$1
	shift
	(cd "$repo_root" && node "packages/pg/src/$module" "$@")
}

# The stamp of the build at the prefix $1, written last: the file named for the SHA-256 of the release's tarball it was
# built from, which holds the tarball's address. A prefix holds the pin's build exactly when it holds the pin's stamp.
core_stamp() { echo "$1/.grizzle-build-$PG_PIN_SHA256"; }

force=0
[[ "${1:-}" == "--force" ]] && force=1

if [[ $force -eq 0 && -e "$(core_stamp "$GRIZZLE_PG_PREFIX")" ]]; then
	echo "PostgreSQL $PG_PIN_VERSION and pgvector $PGVECTOR_PIN_VERSION already built at $GRIZZLE_PG_PREFIX"
	exit 0
fi

# meson installs the prefix's own tree under the staging root, as DESTDIR, so every path the build records is already
# the prefix's: the run path by which every program and module that links libpq loads it, pg_config's compiled-in
# directories, the pkg-config files and PGXS's Makefile.global. pg_config reports its directories relative to where it
# runs, so an extension built with the staged pg_config compiles against the staged headers and installs into the
# staged tree. The paths of those headers that the extension records, the file an error raised in a header's inline
# function reports and the debug information, are mapped back to the prefix, and its run path, which PGXS takes from
# that libdir, is the prefix's.
stage_root="$GRIZZLE_PG_PREFIX.staging"
staged="$stage_root$GRIZZLE_PG_PREFIX"
vector_src="$stage_root/pgvector-$PGVECTOR_PIN_VERSION"
pgxs=(PG_CONFIG="$staged/bin/pg_config" COPT="-ffile-prefix-map=$staged=$GRIZZLE_PG_PREFIX"
	rpathdir="$GRIZZLE_PG_PREFIX/lib")

# Refuses, unless --force is given, while any postmaster runs the prefix's build or the staging tree's, the two trees
# the exchange swaps, and names each by its port and data directory: every postmaster the kernel lists whose executable
# is or was one of theirs (packages/pg/src/foreign-postmasters.ts), so a cluster no command of this repository made is
# named too. With --force it names them as the clusters to restart after the exchange.
refuse_foreign_postmasters() {
	local foreign
	foreign="$(pg_node foreign-postmasters.ts "$GRIZZLE_PG_PREFIX" "$staged")"
	if [[ -z "$foreign" ]]; then
		return 0
	fi
	if [[ $force -eq 0 ]]; then
		printf '%s\n' "Postmasters run from $GRIZZLE_PG_PREFIX, and the exchange would replace their binaries under them:" \
			"$foreign" "Stop each (pnpm pg stop) and run this again, or pass --force to exchange the prefix under them. Nothing was installed." >&2
		exit 1
	fi
	printf '%s\n' "--force: the exchange replaces the binaries of postmasters that run from $GRIZZLE_PG_PREFIX; restart each after it:" \
		"$foreign"
}
refuse_foreign_postmasters

rm -rf "$stage_root"
trap 'rm -rf "$stage_root"' EXIT

# Puts the directory $1 at the path $2 in one renameat2: exchanged with the tree already there, which then sits at $1,
# or moved there when there is none. $2 never names a missing or a partial tree.
exchange() {
	python3 -I -c '
import ctypes, os, sys
AT_FDCWD, RENAME_NOREPLACE, RENAME_EXCHANGE = -100, 0x1, 0x2
source, target = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
libc.renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
flags = RENAME_EXCHANGE if os.path.lexists(target) else RENAME_NOREPLACE
if libc.renameat2(AT_FDCWD, os.fsencode(source), AT_FDCWD, os.fsencode(target), flags) != 0:
	sys.exit(f"Could not move {source} to {target}: {os.strerror(ctypes.get_errno())}")
' "$1" "$2"
}

"$here/source.sh"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$PGVECTOR_PIN_TAG" \
	https://github.com/pgvector/pgvector.git "$vector_src"

meson compile -C "$GRIZZLE_PG_BUILD"
meson test -C "$GRIZZLE_PG_BUILD" -q --print-errorlogs --suite setup --suite regress
meson install -C "$GRIZZLE_PG_BUILD" --quiet --destdir "$stage_root"

make -C "$vector_src" "${pgxs[@]}"
make -C "$vector_src" "${pgxs[@]}" install

printf '%s\n' "$PG_PIN_TARBALL" > "$(core_stamp "$staged")"
echo "Built PostgreSQL $PG_PIN_VERSION and pgvector $PGVECTOR_PIN_VERSION in $staged"

refuse_foreign_postmasters
exchange "$staged" "$GRIZZLE_PG_PREFIX"
echo "Installed PostgreSQL $PG_PIN_VERSION and pgvector $PGVECTOR_PIN_VERSION at $GRIZZLE_PG_PREFIX"
