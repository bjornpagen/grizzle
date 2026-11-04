#!/usr/bin/env bash
# Builds the pinned PostgreSQL with the pin's source patches, pgvector and plpgsql_check natively into
# $GRIZZLE_PG_PREFIX. A completed step for the current pin is skipped unless --force is given.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

force=0
[[ "${1:-}" == "--force" ]] && force=1

mkdir -p "$GRIZZLE_PG_SRC"

# Downloads $1 from $2 into the source cache once and verifies it against the SHA-256 $3.
fetch() {
	local file=$1 url=$2 sha=$3
	[[ -f "$file" ]] || curl -fL -o "$file" "$url"
	echo "$sha  $file" | shasum -a 256 -c -
}

# The core stamp records the patch set it was built with, so a changed set rebuilds.
core_stamp="$GRIZZLE_PG_PREFIX/.grizzle-build-$PG_PIN_COMMIT"
build_core() {
	local tarball="$GRIZZLE_PG_SRC/postgresql-$PG_PIN_VERSION.tar.bz2"
	fetch "$tarball" "$PG_PIN_TARBALL_URL" "$PG_PIN_TARBALL_SHA256"

	local src="$GRIZZLE_PG_SRC/postgresql-$PG_PIN_VERSION"
	rm -rf "$src"
	tar -xjf "$tarball" -C "$GRIZZLE_PG_SRC"

	# git apply allows no fuzz.
	local patches entry file
	patches="$(cd "$(dirname "$0")" && pwd)/patches"
	for entry in $PG_PIN_PATCHES; do
		file="${entry%%=*}"
		echo "${entry#*=}  $patches/$file" | shasum -a 256 -c -
		git -C "$src" apply --check -p1 "$patches/$file"
		git -C "$src" apply -p1 "$patches/$file"
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
		rm -rf "$GRIZZLE_PG_PREFIX"
		meson install -C build --quiet
		# macOS SIP strips DYLD_LIBRARY_PATH from the test wrapper, so the regression suites run after install, where
		# the temporary installation resolves libpq through its rpath into the real prefix.
		meson test -C build -q --print-errorlogs --suite setup --suite regress
	)

	local vector_src="$GRIZZLE_PG_SRC/pgvector-$PGVECTOR_PIN_VERSION"
	rm -rf "$vector_src"
	git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$PGVECTOR_PIN_TAG" \
		https://github.com/pgvector/pgvector.git "$vector_src"
	make -C "$vector_src" PG_CONFIG="$GRIZZLE_PG_PREFIX/bin/pg_config"
	make -C "$vector_src" PG_CONFIG="$GRIZZLE_PG_PREFIX/bin/pg_config" install

	printf '%s' "$PG_PIN_PATCHES" > "$core_stamp"
	echo "Built PostgreSQL $PG_PIN_VERSION and pgvector $PGVECTOR_PIN_VERSION into $GRIZZLE_PG_PREFIX"
}

# plpgsql_check is only ever loaded by the coverage cluster, so installing it leaves the main cluster as it was.
build_plpgsql_check() {
	local tarball="$GRIZZLE_PG_SRC/plpgsql_check-$PLPGSQL_CHECK_PIN_VERSION.tar.gz"
	fetch "$tarball" "$PLPGSQL_CHECK_PIN_TARBALL_URL" "$PLPGSQL_CHECK_PIN_TARBALL_SHA256"
	local src="$GRIZZLE_PG_SRC/plpgsql_check-$PLPGSQL_CHECK_PIN_VERSION"
	rm -rf "$src"
	tar -xzf "$tarball" -C "$GRIZZLE_PG_SRC"
	make -C "$src" PG_CONFIG="$GRIZZLE_PG_PREFIX/bin/pg_config"
	make -C "$src" PG_CONFIG="$GRIZZLE_PG_PREFIX/bin/pg_config" install
	printf '%s' "$PLPGSQL_CHECK_PIN_COMMIT" > "$(plpgsql_check_stamp)"
	echo "Built plpgsql_check $PLPGSQL_CHECK_PIN_VERSION into $GRIZZLE_PG_PREFIX"
}

if [[ -f "$core_stamp" && "$(cat "$core_stamp")" == "$PG_PIN_PATCHES" && $force -eq 0 ]]; then
	echo "PostgreSQL $PG_PIN_VERSION already built at $GRIZZLE_PG_PREFIX"
else
	build_core
fi

if [[ -f "$(plpgsql_check_stamp)" && $force -eq 0 ]]; then
	echo "plpgsql_check $PLPGSQL_CHECK_PIN_VERSION already built at $GRIZZLE_PG_PREFIX"
else
	build_plpgsql_check
fi
