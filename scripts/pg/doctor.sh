#!/usr/bin/env bash
# The go/no-go check for the local cluster GRIZZLE_PG_CLUSTER names by its port, or the default when it is unset
# (lib.sh).
#   doctor.sh [--quick]
# Every check must pass. --quick runs only the checks that need no scratch database.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
require_build

quick=0
[[ "${1:-}" == "--quick" ]] && quick=1

failures=0
pass() { printf "  ok    %s\n" "$1"; }
fail() { printf "  FAIL  %s\n        %s\n" "$1" "$2"; failures=$((failures + 1)); }
check() {
	local name=$1 expected=$2 actual=$3
	if [[ "$actual" == "$expected" ]]; then pass "$name"; else fail "$name" "expected [$expected], got [$actual]"; fi
}
dev() { tls_psql "$PG_DEV_ROLE" "$@" 2>&1; }

echo "grizzle doctor: PostgreSQL $PG_PIN_VERSION at $GRIZZLE_PG_PREFIX, cluster on port $PG_PORT at $GRIZZLE_PG_STATE"

if ! pg_running; then
	fail "cluster running" "start it with scripts/pg/ctl.sh start"
	exit 1
fi

check "server version is $PG_PIN_VERSION" "$PG_PIN_VERSION" \
	"$(dev "$PG_DEV_ROLE" -At -c "SHOW server_version")"
# OpenSSL is covered by the TLS checks; lz4 and zstd are probed through settings that require them.
check "built with lz4" "lz4" "$(dev "$PG_DEV_ROLE" -At -c "SET default_toast_compression = lz4" -c "SHOW default_toast_compression")"
check "built with zstd" "zstd" "$(admin_psql -d postgres -At -c "SET wal_compression = zstd" -c "SHOW wal_compression" 2>&1)"

# Each setting init.sh sizes to this machine holds at least what lib.sh cluster_size gives it, in the setting's own unit.
if sized="$(cluster_size)"; then
	while read -r setting value; do
		held="$(admin_psql -d postgres -At -c "SELECT setting FROM pg_catalog.pg_settings WHERE name = '$setting'")"
		if ((held >= value)); then
			pass "$setting holds $value, sized to this machine"
		else
			fail "$setting holds $value, sized to this machine" "it is $held: scripts/pg/init.sh sizes a cluster"
		fi
	done <<<"$sized"
else
	fail "the cluster's size for this machine" "scripts/pg/lib.sh cluster_size failed"
fi

# Every table the connection lease locks exists: the cluster creates them (init.sh), never a lease.
if leased="$(lease_tables)"; then
	check "the connection lease's $(wc -l <<<"$leased") tables exist" "" \
		"$(dev "$PG_DEV_ROLE" -At -c "SELECT pg_catalog.string_agg(t, ' ') FROM pg_catalog.unnest(pg_catalog.string_to_array('${leased//$'\n'/ }', ' ')) AS t WHERE pg_catalog.to_regclass(pg_catalog.format('public.%I', t)) IS NULL")"
else
	fail "the connection lease's tables" "scripts/pg/lib.sh lease_tables failed"
fi

check "jit is off by default" "off" \
	"$(dev "$PG_DEV_ROLE" -At -c "SHOW jit")"

check "max_pred_locks_per_relation is 1023, production's promotion" "1023" \
	"$(dev "$PG_DEV_ROLE" -At -c "SHOW max_pred_locks_per_relation")"

check "wal_level is logical" "logical" \
	"$(dev "$PG_DEV_ROLE" -At -c "SHOW wal_level")"
bound="$(live_slot_bound)"
for setting in max_replication_slots max_wal_senders; do
	held="$(dev "$PG_DEV_ROLE" -At -c "SHOW $setting")"
	if ((held >= bound)); then
		pass "$setting holds the live source bound $bound"
	else
		fail "$setting holds the live source bound $bound" "it is $held: scripts/pg/init.sh's ALTER SYSTEM, then a restart"
	fi
done
check "$PG_DEV_ROLE holds REPLICATION, to give each decoder login its right" "t" \
	"$(dev "$PG_DEV_ROLE" -At -c "SELECT rolreplication FROM pg_catalog.pg_roles WHERE rolname = current_user")"
check "a hostssl scram line admits every role to every database, the decoder logins' logical replication too" "t" \
	"$(admin_psql -d postgres -At -c "SELECT bool_or(type = 'hostssl' AND 'all' = ANY(database) AND 'all' = ANY(user_name) AND auth_method = 'scram-sha-256') FROM pg_catalog.pg_hba_file_rules")"

check "$PG_DEV_ROLE holds SET on deadlock_timeout" "t" \
	"$(dev "$PG_DEV_ROLE" -At -c "SELECT has_parameter_privilege('deadlock_timeout', 'SET')")"

check "$PG_DEV_ROLE holds pg_read_all_stats WITH ADMIN, SET, and no INHERIT" "t|f|t|f" \
	"$(dev "$PG_DEV_ROLE" -At -c "SELECT m.admin_option, m.inherit_option, m.set_option, pg_catalog.has_table_privilege('pg_catalog.pg_backend_memory_contexts', 'SELECT') FROM pg_catalog.pg_auth_members AS m WHERE m.roleid = 'pg_read_all_stats'::regrole AND m.member = current_user::regrole")"

check "verify-full TLS connects" "on" "$(dev "$PG_DEV_ROLE" -At -c "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()" | sed 's/^t$/on/')"
psql_bin="$(pg_bin psql)"
password="$(cat "$GRIZZLE_PG_DEV_PASSWORD_FILE")"
refused() {
	local name=$1 conninfo=$2
	if PGPASSWORD="$password" "$psql_bin" -X -At "$conninfo" -c "SELECT 1" >/dev/null 2>&1; then
		fail "$name" "connection was accepted"
	else
		pass "$name"
	fi
}
refused "wrong CA refused" "host=localhost port=$PG_PORT dbname=$PG_DEV_ROLE user=$PG_DEV_ROLE sslmode=verify-full sslrootcert=$GRIZZLE_PG_TLS/wrong-ca.crt"
refused "wrong hostname refused" "host=127.0.0.1 port=$PG_PORT dbname=$PG_DEV_ROLE user=$PG_DEV_ROLE sslmode=verify-full sslrootcert=$GRIZZLE_PG_TLS/ca.crt sslsni=0 hostaddr=127.0.0.1 host=grizzle.invalid"
refused "plaintext refused" "host=localhost port=$PG_PORT dbname=$PG_DEV_ROLE user=$PG_DEV_ROLE sslmode=disable"

if [[ $quick -eq 1 ]]; then
	[[ $failures -eq 0 ]] && echo "doctor --quick: all checks passed" || echo "doctor --quick: $failures check(s) failed"
	exit $((failures > 0))
fi

scratch="gz_doctor_$$"
dev "$PG_DEV_ROLE" -c "CREATE DATABASE $scratch TEMPLATE $PG_TEMPLATE_DB" >/dev/null
trap 'tls_psql "$PG_DEV_ROLE" "$PG_DEV_ROLE" -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" >/dev/null 2>&1' EXIT

# btree_gist is trusted, so the non-superuser owner creates it; vector comes from the template.
check "CREATE EXTENSION btree_gist as $PG_DEV_ROLE" "" \
	"$(dev "$scratch" -c "CREATE EXTENSION btree_gist")"
check "vector $PGVECTOR_PIN_VERSION present in vector_ext" "$PGVECTOR_PIN_VERSION|vector_ext" \
	"$(dev "$scratch" -At -c "SELECT e.extversion || '|' || n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'")"
check "vector distance works" "1" \
	"$(dev "$scratch" -At -c "SELECT vector_ext.cosine_distance('[1,0]'::vector_ext.vector, '[0,1]'::vector_ext.vector)")"

check "database encoding, provider, locale" "UTF8|b|C.UTF-8" \
	"$(dev "$scratch" -At -c "SELECT pg_encoding_to_char(encoding) || '|' || datlocprovider::text || '|' || datlocale FROM pg_database WHERE datname = current_database()")"

money="$(dev "$scratch" -At -c "SET lc_monetary = 'C.UTF-8'" -c "SELECT 1234.5::money")"
if [[ "$money" =~ 1,?234\.50$ ]]; then pass "C.UTF-8 money has two fractional digits ($money)"; else fail "C.UTF-8 money has two fractional digits" "got [$money]"; fi

dev "$scratch" -c "CREATE TABLE t (id int PRIMARY KEY, v text NOT NULL)" -c "INSERT INTO t VALUES (1, 'a')" >/dev/null
check "DO SELECT exact repeat returns nothing" "" \
	"$(dev "$scratch" -At -c "INSERT INTO t AS r VALUES (1, 'a') ON CONFLICT (id) DO SELECT WHERE (r.v) <> (EXCLUDED.v) RETURNING r.id, r.v")"
check "DO SELECT different payload returns the witness" "1|a" \
	"$(dev "$scratch" -At -c "INSERT INTO t AS r VALUES (1, 'b') ON CONFLICT (id) DO SELECT WHERE (r.v) <> (EXCLUDED.v) RETURNING r.id, r.v")"

[[ $failures -eq 0 ]] && echo "doctor: all checks passed" || echo "doctor: $failures check(s) failed"
exit $((failures > 0))
