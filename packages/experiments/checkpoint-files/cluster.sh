# shellcheck shell=bash
# The local cluster TOOLCHAIN_PG_CLUSTER names (unset, pg.config.ts's), as the testing library keeps it under
# ~/.local/var/toolchain-pg/<cluster>/, for this experiment's scripts. Sourced, never executed.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$repo_root/scripts/pg/pin.env"
# The cluster's first member, brought up, as `toolchain-pg env` prints it: TOOLCHAIN_PG_PORT, the cluster's name, and
# TOOLCHAIN_PG_SOCKET, whose directory's parent is the member's state directory, which every member's lies beside.
eval "$(cd "$repo_root" && node_modules/.bin/toolchain-pg env)"
cluster_root="$(dirname "$(dirname "$TOOLCHAIN_PG_SOCKET")")"
pg_bin() { echo "$GRIZZLE_PG_PREFIX/bin/$1"; }
# The ports of the cluster's members, one a line in member order, as its manifest records them.
family_ports() {
	python3 -I -c 'import json, sys; print("\n".join(str(port) for port in json.load(open(sys.argv[1]))["members"]))' \
		"$cluster_root/cluster.json"
}
# member_env <port>: the port, PG_PORT, and the paths of the member on <port>.
member_env() {
	PG_PORT=$1
	GRIZZLE_PG_DATA="$cluster_root/$1/data"
	GRIZZLE_PG_SOCKET="$cluster_root/$1/socket"
	GRIZZLE_PG_LOG="$cluster_root/$1/log"
}
member_env "$TOOLCHAIN_PG_PORT"
