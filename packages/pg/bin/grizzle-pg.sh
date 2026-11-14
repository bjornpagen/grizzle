#!/usr/bin/env bash
# The local cluster's commands (scripts/pg) for a workspace that takes grizzle as a git submodule, which links this
# bin: each runs from the checkout this package lies in, its TypeScript from this package (scripts/pg/lib.sh pg_node),
# whose dependencies are the workspace's own, so the checkout needs no install of its own.
#   grizzle-pg build [--force]       build the pinned PostgreSQL (scripts/pg/build.sh)
#   grizzle-pg source                its source tree (scripts/pg/source.sh)
#   grizzle-pg init [--force]        make a cluster (scripts/pg/init.sh)
#   grizzle-pg doctor                check it (scripts/pg/doctor.sh)
#   grizzle-pg <command> [args...]   run it: start, stop, status, psql, admin, reset, env, destroy (scripts/pg/ctl.sh)
set -euo pipefail
scripts="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../scripts/pg" && pwd)"
case "${1:-}" in
	build | source | init | doctor)
		command=$1
		shift
		exec "$scripts/$command.sh" "$@"
		;;
	*)
		exec "$scripts/ctl.sh" "$@"
		;;
esac
