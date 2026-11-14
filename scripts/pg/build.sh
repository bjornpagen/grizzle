#!/usr/bin/env bash
# Builds the pinned PostgreSQL with the pin's source patches and pgvector natively, and installs the build at
# $GRIZZLE_PG_PREFIX. A prefix that already holds the current pin is kept unless --force is given.
#
# The source is the git repository source.sh keeps at $GRIZZLE_PG_SRC, the pinned release and one commit for each of
# the pin's patches, and the build is made in $GRIZZLE_PG_BUILD beside the prefix, which source.sh makes anew, so
# nothing is built in the source. The prefix holds a complete build, or the build it held before, and never anything in
# between. Every input is fetched first. PostgreSQL's regression suites must pass, and the source must still be the
# pin's, before the build is installed into a staging tree beside the prefix, on the same file system; pgvector is
# checked out and built into that tree and the stamp is written last. Only then does one rename exchange the tree with
# the prefix. A failure before the exchange leaves the prefix as it was, and the staging tree, which holds the previous
# build after the exchange, is removed on every exit. The cluster runs from the prefix, so a cluster running at the
# exchange is stopped just before it and started again just after it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"

force=0
[[ "${1:-}" == "--force" ]] && force=1

if [[ $force -eq 0 && -f "$(core_stamp "$GRIZZLE_PG_PREFIX")" &&
	"$(cat "$(core_stamp "$GRIZZLE_PG_PREFIX")")" == "$PG_PIN_PATCHES" ]]; then
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

# Whether the cluster was stopped for the exchange. Every exit starts it again, from the new build after the exchange
# and from the previous one before it, so no failure leaves it down.
stopped=0
finish() {
	local status=$?
	if [[ $stopped -eq 1 ]] && ! "$here/ctl.sh" start; then
		echo "The cluster did not start; its log is $GRIZZLE_PG_LOG/startup.log" >&2
		status=1
	fi
	rm -rf "$stage_root"
	exit "$status"
}
rm -rf "$stage_root"
trap finish EXIT

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
# An edit made in the source while it was built would be installed as the pin's build.
if [[ -n "$(git -C "$GRIZZLE_PG_SRC" status --porcelain --untracked-files=all)" ||
	"$(git -C "$GRIZZLE_PG_SRC" rev-parse HEAD)" != "$(git -C "$GRIZZLE_PG_SRC" rev-parse refs/tags/pinned)" ]]; then
	echo "$GRIZZLE_PG_SRC changed while it was built, so the build is not the pin's; nothing was installed" >&2
	exit 1
fi
meson install -C "$GRIZZLE_PG_BUILD" --quiet --destdir "$stage_root"

make -C "$vector_src" "${pgxs[@]}"
make -C "$vector_src" "${pgxs[@]}" install

printf '%s' "$PG_PIN_PATCHES" > "$(core_stamp "$staged")"
echo "Built PostgreSQL $PG_PIN_VERSION and pgvector $PGVECTOR_PIN_VERSION in $staged"

if pg_running; then
	echo "The cluster runs from $GRIZZLE_PG_PREFIX; it is restarted around the exchange, which replaces its binaries"
	stopped=1
	"$here/ctl.sh" stop
fi
exchange "$staged" "$GRIZZLE_PG_PREFIX"
echo "Installed PostgreSQL $PG_PIN_VERSION and pgvector $PGVECTOR_PIN_VERSION at $GRIZZLE_PG_PREFIX"
