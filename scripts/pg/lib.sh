# Shared helpers for scripts/pg. Sourced, never executed.
# shellcheck shell=bash
source "$(dirname "${BASH_SOURCE[0]}")/pin.env"

# The repository's root, where node runs the repository's scripts (repo_node).
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo_node() { (cd "$repo_root" && node "$@"); }

# The local cluster GRIZZLE_PG_CLUSTER names, or the default when it is unset: its port, PG_PORT, its state directory,
# GRIZZLE_PG_STATE, and the paths in it, declared from test/support/env.ts selectCluster, the one formula, which
# scripts/pg/cluster.ts prints. A name that is no cluster stops every script here.
cluster="$(repo_node scripts/pg/cluster.ts)" || exit 1
while IFS= read -r assignment; do
	declare -- "$assignment"
done <<<"$cluster"
unset cluster assignment

pg_bin() { echo "$GRIZZLE_PG_PREFIX/bin/$1"; }

# The stamp of the build at the prefix $1, which build.sh writes last. It holds the patch set the build was made with,
# so a changed set rebuilds.
core_stamp() { echo "$1/.grizzle-build-$PG_PIN_COMMIT"; }

require_build() {
	if [[ ! -f "$(core_stamp "$GRIZZLE_PG_PREFIX")" ]]; then
		echo "PostgreSQL $PG_PIN_VERSION is not built; run scripts/pg/build.sh" >&2
		exit 1
	fi
}

# The settings that size the cluster to this machine, one "<setting> <value>" line each, the value in the setting's own
# unit: test/support/substrate/shared.ts clusterSize, the one formula, which init.sh writes and doctor.sh requires.
cluster_size() {
	repo_node scripts/pg/cluster-size.ts
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
# (scripts/pg/port-free.ts).
require_port_free() {
	if ! repo_node scripts/pg/port-free.ts; then
		echo "Port $PG_PORT is taken: name another cluster with GRIZZLE_PG_CLUSTER=<port>" >&2
		exit 1
	fi
}

# The names of the substrate lease's tables, one per line: test/support/substrate/shared.ts substrateLeaseNames, the one
# formula, over the running cluster's max_connections, superuser_reserved_connections and reserved_connections.
lease_tables() {
	local settings
	settings="$(admin_psql -d postgres -At -F ' ' -c "SELECT current_setting('max_connections'), current_setting('superuser_reserved_connections'), current_setting('reserved_connections')")"
	repo_node scripts/pg/lease-tables.ts $settings
}

# The most live sources the cluster serves at once, which max_replication_slots and max_wal_senders must each hold:
# test/support/substrate/shared.ts liveSlotBound, the one formula, over the running cluster's max_connections,
# superuser_reserved_connections and reserved_connections.
live_slot_bound() {
	local settings
	settings="$(admin_psql -d postgres -At -F ' ' -c "SELECT current_setting('max_connections'), current_setting('superuser_reserved_connections'), current_setting('reserved_connections')")"
	repo_node scripts/pg/live-slot-bound.ts $settings
}
