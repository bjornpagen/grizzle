#!/usr/bin/env bash
# The pinned PostgreSQL build's commands (scripts/pg) for a workspace that takes grizzle as a git submodule, which links
# this bin: each runs from the checkout this package lies in, its TypeScript from this package, whose dependencies are
# the workspace's own, so the checkout needs no install of its own. The clusters of the build are the testing library's
# (`toolchain-pg`, over the workspace's pg.config.ts).
#   grizzle-pg build [--force]       build the pinned PostgreSQL (scripts/pg/build.sh)
#   grizzle-pg source                its source tree (scripts/pg/source.sh)
set -euo pipefail
scripts="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../scripts/pg" && pwd)"
case "${1:-}" in
	build | source)
		command=$1
		shift
		exec "$scripts/$command.sh" "$@"
		;;
	*)
		echo "usage: grizzle-pg build [--force] | grizzle-pg source" >&2
		exit 2
		;;
esac
