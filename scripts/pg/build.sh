#!/usr/bin/env bash
# Builds the pinned PostgreSQL with the pin's source patches and pgvector natively, and installs the build at
# $GRIZZLE_PG_PREFIX. A prefix that already holds the current pin is kept unless --force is given.
#
# The prefix holds a complete build, or the build it held before, and never anything in between. Every input is
# fetched first. PostgreSQL's regression suites must pass before the build is installed into a staging tree beside the
# prefix, on the same file system; pgvector is built into that tree and the stamp is written last. Only then does one
# rename exchange the tree with the prefix. A failure before the exchange leaves the prefix as it was, and the staging
# tree, which holds the previous build after the exchange, is removed on every exit. The cluster runs from the prefix,
# so a cluster running at the exchange is stopped just before it and started again just after it.
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

# Downloads $1 from $2 into the source cache once and verifies it against the SHA-256 $3.
fetch() {
	local file=$1 url=$2 sha=$3
	[[ -f "$file" ]] || curl -fL -o "$file" "$url"
	echo "$sha  $file" | sha256sum -c -
}

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

mkdir -p "$GRIZZLE_PG_SRC"
src="$GRIZZLE_PG_SRC/postgresql-$PG_PIN_VERSION"
vector_src="$GRIZZLE_PG_SRC/pgvector-$PGVECTOR_PIN_VERSION"

pg_tarball="$GRIZZLE_PG_SRC/postgresql-$PG_PIN_VERSION.tar.bz2"
fetch "$pg_tarball" "$PG_PIN_TARBALL_URL" "$PG_PIN_TARBALL_SHA256"
rm -rf "$vector_src"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$PGVECTOR_PIN_TAG" \
	https://github.com/pgvector/pgvector.git "$vector_src"

rm -rf "$src"
tar -xjf "$pg_tarball" -C "$GRIZZLE_PG_SRC"

# git apply allows no fuzz.
for entry in $PG_PIN_PATCHES; do
	file="${entry%%=*}"
	echo "${entry#*=}  $here/patches/$file" | sha256sum -c -
	git -C "$src" apply --check -p1 "$here/patches/$file"
	git -C "$src" apply -p1 "$here/patches/$file"
done

# The libraries go to the prefix's lib, where pgvector's run path names them, not to the multiarch directory meson picks
# on Ubuntu. The regression suites run the build's temporary installation, whose programs and modules carry the
# prefix's lib as their run path, and the prefix holds the previous build or none. meson's test environment puts the
# temporary installation's library directory first on LD_LIBRARY_PATH, which every program pg_regress starts inherits,
# and the loader searches LD_LIBRARY_PATH before a RUNPATH, so the suites test this build alone. The link writes the run
# path as RUNPATH: an RPATH would come before LD_LIBRARY_PATH.
(
	cd "$src"
	meson setup build \
		--prefix="$GRIZZLE_PG_PREFIX" --libdir=lib \
		-Dc_link_args=-Wl,--enable-new-dtags \
		-Dllvm=disabled -Dssl=openssl -Dlz4=enabled -Dzstd=enabled -Dreadline=enabled \
		-Dicu=disabled -Ddocs=disabled -Dtap_tests=disabled -Dcassert=false
	meson compile -C build
	meson test -C build -q --print-errorlogs --suite setup --suite regress
	meson install -C build --quiet --destdir "$stage_root"
)

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
