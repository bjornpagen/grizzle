# Shared helpers for scripts/pg. Sourced, never executed.
# shellcheck shell=bash
source "$(dirname "${BASH_SOURCE[0]}")/pin.env"

# The repository's root, and pg_node, which runs the module <name> of packages/pg/src: the package the installing
# workspace links, whose own node_modules hold what its modules import, so a checkout taken as a submodule runs these
# scripts from its consumer's install and never needs an install of its own.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pg_node() {
	local module=$1
	shift
	(cd "$repo_root" && node "packages/pg/src/$module" "$@")
}

# The local cluster GRIZZLE_PG_CLUSTER names, or the default when it is unset: its port, PG_PORT, its state directory,
# GRIZZLE_PG_STATE, and the paths in it, declared from packages/pg/src/local-cluster.ts selectCluster, the one formula,
# which packages/pg/src/cluster.ts prints. A name that is no cluster stops every script here.
cluster="$(pg_node cluster.ts)" || exit 1
while IFS= read -r assignment; do
	declare -- "$assignment"
done <<<"$cluster"
unset cluster assignment

pg_bin() { echo "$GRIZZLE_PG_PREFIX/bin/$1"; }

# The stamp of the build at the prefix $1, which build.sh writes last: the file named stamp_stem and the release's
# commit, which holds the patch set the build was made with. build.sh reads the installation's through
# packages/pg/src/pin-verdict.ts, so a changed set rebuilds and an older one of the same release is refused.
stamp_stem=.grizzle-build-
core_stamp() { echo "$1/$stamp_stem$PG_PIN_COMMIT"; }

require_build() {
	if [[ ! -f "$(core_stamp "$GRIZZLE_PG_PREFIX")" ]]; then
		echo "PostgreSQL $PG_PIN_VERSION is not built; run scripts/pg/build.sh" >&2
		exit 1
	fi
}

# The settings that size the cluster to this machine, one "<setting> <value>" line each, the value in the setting's own
# unit: packages/pg/src/size.ts clusterSize, the one formula, which init.sh writes and doctor.sh requires.
cluster_size() {
	pg_node cluster-size.ts
}

admin_psql() {
	"$(pg_bin psql)" -X -q -v ON_ERROR_STOP=1 -h "$GRIZZLE_PG_SOCKET" -p "$PG_PORT" -U postgres "$@"
}

# Usage: tls_psql <role> <database> [psql args...]
tls_psql() {
	local role=$1 db=$2
	shift 2
	PGPASSWORD="$(cat "$GRIZZLE_PG_DEV_PASSWORD_FILE")" "$(pg_bin psql)" -X -q -v ON_ERROR_STOP=1 \
		"host=localhost port=$PG_PORT dbname=$db user=$role sslmode=verify-full sslrootcert=$GRIZZLE_PG_TLS/ca.crt" "$@"
}

pg_running() {
	"$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" status >/dev/null 2>&1
}

# Refuses, with a failing exit, unless the cluster's port is free on every address localhost names
# (packages/pg/src/port-free.ts).
require_port_free() {
	if ! pg_node port-free.ts; then
		echo "Port $PG_PORT is taken: name another cluster with GRIZZLE_PG_CLUSTER=<port>" >&2
		exit 1
	fi
}

# The names of the substrate lease's tables, one per line: packages/pg/src/lease.ts substrateLeaseNames, the one
# formula, over the running cluster's max_connections, superuser_reserved_connections and reserved_connections.
lease_tables() {
	local settings
	settings="$(admin_psql -d postgres -At -F ' ' -c "SELECT current_setting('max_connections'), current_setting('superuser_reserved_connections'), current_setting('reserved_connections')")"
	pg_node lease-tables.ts $settings
}

# The most live sources the cluster serves at once, which max_replication_slots and max_wal_senders must each hold:
# packages/pg/src/lease.ts liveSlotBound, the one formula, over the running cluster's max_connections,
# superuser_reserved_connections and reserved_connections.
live_slot_bound() {
	local settings
	settings="$(admin_psql -d postgres -At -F ' ' -c "SELECT current_setting('max_connections'), current_setting('superuser_reserved_connections'), current_setting('reserved_connections')")"
	pg_node live-slot-bound.ts $settings
}
