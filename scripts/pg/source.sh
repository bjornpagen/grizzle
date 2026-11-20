#!/usr/bin/env bash
# Puts the pinned PostgreSQL release's source at $GRIZZLE_PG_SRC, and a build directory for it, configured to install at
# $GRIZZLE_PG_PREFIX, at $GRIZZLE_PG_BUILD. build.sh runs it first; run it alone to read the source the build is made
# from.
#
# The source is the release's tarball, PG_PIN_TARBALL, and nothing else: the official release, unpatched, as hosted
# providers build it. The tarball is fetched once to $GRIZZLE_PG_TARBALL, put there only after its SHA-256 is the pin's
# PG_PIN_SHA256, and verified again before every extraction, so a tarball that is not the pinned release is refused,
# never extracted. The source and the build directory are made anew on every run, so nothing of an earlier source or
# build is left in either, and nothing is ever built in the source.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/pin.env"

# Whether the file $1 is the pinned release: its SHA-256 is PG_PIN_SHA256.
pinned_release() { echo "$PG_PIN_SHA256  $1" | sha256sum --check --quiet --strict - >/dev/null 2>&1; }

if [[ ! -e "$GRIZZLE_PG_TARBALL" ]]; then
	fetched="$GRIZZLE_PG_TARBALL.part"
	trap 'rm -f "$fetched"' EXIT
	mkdir -p "$(dirname "$GRIZZLE_PG_TARBALL")"
	curl --fail --silent --show-error --location --proto '=https' --output "$fetched" "$PG_PIN_TARBALL"
	if ! pinned_release "$fetched"; then
		echo "$PG_PIN_TARBALL is not the pinned release: its SHA-256 is $(sha256sum "$fetched" | cut -d' ' -f1), not $PG_PIN_SHA256" >&2
		exit 1
	fi
	mv "$fetched" "$GRIZZLE_PG_TARBALL"
fi
if ! pinned_release "$GRIZZLE_PG_TARBALL"; then
	echo "$GRIZZLE_PG_TARBALL is not the pinned release: its SHA-256 is not $PG_PIN_SHA256. Remove it and run this again." >&2
	exit 1
fi

rm -rf "$GRIZZLE_PG_SRC"
mkdir -p "$GRIZZLE_PG_SRC"
tar --extract --bzip2 --file "$GRIZZLE_PG_TARBALL" --directory "$GRIZZLE_PG_SRC" --strip-components 1
echo "PostgreSQL $PG_PIN_VERSION at $GRIZZLE_PG_SRC: $PG_PIN_TARBALL, SHA-256 $PG_PIN_SHA256 ($PG_PIN_TAG, $PG_PIN_COMMIT)"

# The libraries go to the prefix's lib, where pgvector's run path names them, not to the multiarch directory meson picks
# on Ubuntu. The regression suites run the build's temporary installation, whose programs and modules carry the
# prefix's lib as their run path, and the prefix holds the previous build or none. meson's test environment puts the
# temporary installation's library directory first on LD_LIBRARY_PATH, which every program pg_regress starts inherits,
# and the loader searches LD_LIBRARY_PATH before a RUNPATH, so the suites test this build alone. The link writes the run
# path as RUNPATH: an RPATH would come before LD_LIBRARY_PATH.
rm -rf "$GRIZZLE_PG_BUILD"
mkdir -p "$(dirname "$GRIZZLE_PG_BUILD")"
meson setup "$GRIZZLE_PG_BUILD" "$GRIZZLE_PG_SRC" \
	--prefix="$GRIZZLE_PG_PREFIX" --libdir=lib \
	-Dc_link_args=-Wl,--enable-new-dtags \
	-Dllvm=disabled -Dssl=openssl -Dlz4=enabled -Dzstd=enabled -Dreadline=enabled \
	-Dicu=disabled -Ddocs=disabled -Dtap_tests=disabled -Dcassert=false
