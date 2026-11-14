# Shared helpers for scripts/pg. Sourced, never executed.
# shellcheck shell=bash
source "$(dirname "${BASH_SOURCE[0]}")/pin.env"

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
	(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && node --conditions=grizzle-source scripts/pg/cluster-size.ts)
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

# The most live sources the cluster serves at once, which max_replication_slots and max_wal_senders must each hold:
# test/support/substrate/shared.ts liveSlotBound, the one formula, over the running cluster's max_connections,
# superuser_reserved_connections and reserved_connections.
live_slot_bound() {
	local settings
	settings="$(admin_psql -d postgres -At -F ' ' -c "SELECT current_setting('max_connections'), current_setting('superuser_reserved_connections'), current_setting('reserved_connections')")"
	(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && node --conditions=grizzle-source scripts/pg/live-slot-bound.ts $settings)
}
