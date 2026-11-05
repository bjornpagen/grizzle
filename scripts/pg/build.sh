#!/usr/bin/env bash
# Builds the pinned PostgreSQL with the pin's source patches, pgvector and plpgsql_check natively, and installs the
# build at $GRIZZLE_PG_PREFIX. A prefix that already holds the current pin is kept unless --force is given.
#
# The prefix holds a complete build, or the build it held before, and never anything in between. Every input is
# fetched first. PostgreSQL's regression suites must pass before the build is installed into a staging tree beside the
# prefix, on the same file system; the extensions are built into that tree and the stamps are written last. Only then
# does one rename exchange the tree with the prefix. A failure before the exchange leaves the prefix as it was, and the
# staging tree, which holds the previous build after the exchange, is removed on every exit. Both clusters run from
# the prefix, so a cluster running at the exchange is stopped just before it and started again just after it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"

force=0
[[ "${1:-}" == "--force" ]] && force=1

if [[ $force -eq 0 && -f "$(core_stamp "$GRIZZLE_PG_PREFIX")" && -f "$(plpgsql_check_stamp "$GRIZZLE_PG_PREFIX")" &&
	"$(cat "$(core_stamp "$GRIZZLE_PG_PREFIX")")" == "$PG_PIN_PATCHES" ]]; then
	echo "PostgreSQL $PG_PIN_VERSION, pgvector $PGVECTOR_PIN_VERSION and plpgsql_check $PLPGSQL_CHECK_PIN_VERSION already built at $GRIZZLE_PG_PREFIX"
	exit 0
fi

# meson installs the prefix's own tree under the staging root, as DESTDIR, so every path the build records is already
# the prefix's: libpq's install name, by which every program that links it loads it, pg_config's compiled-in
# directories, the pkg-config files and PGXS's Makefile.global. pg_config reports its directories relative to where it
# runs, so an extension built with the staged pg_config compiles against the staged headers and installs into the
# staged tree. The paths of those headers that the extension records, the file an error raised in a header's inline
# function reports and the debug information, are mapped back to the prefix.
stage_root="$GRIZZLE_PG_PREFIX.staging"
staged="$stage_root$GRIZZLE_PG_PREFIX"
pgxs=(PG_CONFIG="$staged/bin/pg_config" COPT="-ffile-prefix-map=$staged=$GRIZZLE_PG_PREFIX")

# Runs ctl.sh on the cluster $1 with the remaining arguments.
ctl() {
	local cluster=$1
	shift
	case "$cluster" in
		main) "$here/ctl.sh" "$@" ;;
		coverage) "$here/ctl.sh" --coverage "$@" ;;
	esac
}

# The clusters stopped for the exchange. Every exit starts each of them again, from the new build after the exchange
# and from the previous one before it, so no failure leaves a cluster down.
stopped=""
finish() {
	local status=$? cluster
	for cluster in $stopped; do
		if ! ctl "$cluster" start; then
			echo "The $cluster cluster did not start; its log is $(use_cluster "$cluster" && echo "$GRIZZLE_PG_LOG")/startup.log" >&2
			status=1
		fi
	done
	rm -rf "$stage_root"
	exit "$status"
}
rm -rf "$stage_root"
trap finish EXIT

# Downloads $1 from $2 into the source cache once and verifies it against the SHA-256 $3.
fetch() {
	local file=$1 url=$2 sha=$3
	[[ -f "$file" ]] || curl -fL -o "$file" "$url"
	echo "$sha  $file" | shasum -a 256 -c -
}

# pg_regress runs psql through /bin/sh, and SIP strips DYLD_LIBRARY_PATH from every protected program it starts, so
# the programs of the temporary installation under $1 load libpq by its install name, from the prefix, which holds the
# previous build or none. Every reference into the prefix is pointed at the temporary installation's own copy instead,
# so the suites test this build alone. install_name_tool renews the ad-hoc signature of each file it changes.
isolate_test_install() {
	local root=$1 file dep
	while IFS= read -r file; do
		while IFS= read -r dep; do
			install_name_tool -change "$dep" "$root$dep" "$file"
		done < <(otool -XL "$file" | sed -n "s|^[[:space:]]*\($GRIZZLE_PG_PREFIX/[^ ]*\) (compatibility version .*|\1|p")
	done < <(find "$root$GRIZZLE_PG_PREFIX/bin" -type f; find "$root$GRIZZLE_PG_PREFIX/lib" -maxdepth 1 -type f -name '*.dylib')
}

# Puts the directory $1 at the path $2 in one rename: exchanged with the tree already there, which then sits at $1,
# or moved there when there is none. $2 never names a missing or a partial tree.
exchange() {
	python3 -I -c '
import ctypes, os, sys
RENAME_SWAP, RENAME_EXCL = 0x2, 0x4
source, target = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
libc.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
flags = RENAME_SWAP if os.path.lexists(target) else RENAME_EXCL
if libc.renamex_np(os.fsencode(source), os.fsencode(target), flags) != 0:
	sys.exit(f"Could not move {source} to {target}: {os.strerror(ctypes.get_errno())}")
' "$1" "$2"
}

mkdir -p "$GRIZZLE_PG_SRC"
src="$GRIZZLE_PG_SRC/postgresql-$PG_PIN_VERSION"
vector_src="$GRIZZLE_PG_SRC/pgvector-$PGVECTOR_PIN_VERSION"
check_src="$GRIZZLE_PG_SRC/plpgsql_check-$PLPGSQL_CHECK_PIN_VERSION"

pg_tarball="$GRIZZLE_PG_SRC/postgresql-$PG_PIN_VERSION.tar.bz2"
check_tarball="$GRIZZLE_PG_SRC/plpgsql_check-$PLPGSQL_CHECK_PIN_VERSION.tar.gz"
fetch "$pg_tarball" "$PG_PIN_TARBALL_URL" "$PG_PIN_TARBALL_SHA256"
fetch "$check_tarball" "$PLPGSQL_CHECK_PIN_TARBALL_URL" "$PLPGSQL_CHECK_PIN_TARBALL_SHA256"
rm -rf "$vector_src"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$PGVECTOR_PIN_TAG" \
	https://github.com/pgvector/pgvector.git "$vector_src"

rm -rf "$src" "$check_src"
tar -xjf "$pg_tarball" -C "$GRIZZLE_PG_SRC"
tar -xzf "$check_tarball" -C "$GRIZZLE_PG_SRC"

# git apply allows no fuzz.
for entry in $PG_PIN_PATCHES; do
	file="${entry%%=*}"
	echo "${entry#*=}  $here/patches/$file" | shasum -a 256 -c -
	git -C "$src" apply --check -p1 "$here/patches/$file"
	git -C "$src" apply -p1 "$here/patches/$file"
done

# Keg-only Homebrew libraries are found only through pkg-config.
export PKG_CONFIG_PATH="$HOMEBREW_PREFIX/opt/readline/lib/pkgconfig:$HOMEBREW_PREFIX/opt/openssl@3/lib/pkgconfig:$HOMEBREW_PREFIX/opt/lz4/lib/pkgconfig:$HOMEBREW_PREFIX/opt/zstd/lib/pkgconfig"

(
	cd "$src"
	meson setup build \
		--prefix="$GRIZZLE_PG_PREFIX" \
		-DBISON="$HOMEBREW_PREFIX/opt/bison/bin/bison" \
		-DFLEX="$HOMEBREW_PREFIX/opt/flex/bin/flex" \
		-Dllvm=disabled -Dssl=openssl -Dlz4=enabled -Dzstd=enabled -Dreadline=enabled \
		-Dicu=disabled -Ddocs=disabled -Dtap_tests=disabled -Dcassert=false
	meson compile -C build
	meson test -C build -q --print-errorlogs --suite setup
	isolate_test_install "$src/build/tmp_install"
	meson test -C build -q --print-errorlogs --suite regress
	meson install -C build --quiet --destdir "$stage_root"
)

for extension_src in "$vector_src" "$check_src"; do
	make -C "$extension_src" "${pgxs[@]}"
	make -C "$extension_src" "${pgxs[@]}" install
done

printf '%s' "$PLPGSQL_CHECK_PIN_COMMIT" > "$(plpgsql_check_stamp "$staged")"
printf '%s' "$PG_PIN_PATCHES" > "$(core_stamp "$staged")"
echo "Built PostgreSQL $PG_PIN_VERSION, pgvector $PGVECTOR_PIN_VERSION and plpgsql_check $PLPGSQL_CHECK_PIN_VERSION in $staged"

running=""
for cluster in $PG_CLUSTERS; do
	if (use_cluster "$cluster" && pg_running); then running="$running $cluster"; fi
done
echo "Clusters running from $GRIZZLE_PG_PREFIX, restarted around the exchange because it replaces their binaries:${running:- none}"
for cluster in $running; do
	stopped="$stopped $cluster"
	ctl "$cluster" stop
done
exchange "$staged" "$GRIZZLE_PG_PREFIX"
echo "Installed PostgreSQL $PG_PIN_VERSION, pgvector $PGVECTOR_PIN_VERSION and plpgsql_check $PLPGSQL_CHECK_PIN_VERSION at $GRIZZLE_PG_PREFIX"
