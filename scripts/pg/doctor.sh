#!/usr/bin/env bash
# The go/no-go check for a local cluster: the main one, or with --coverage the coverage one.
#   doctor.sh [--coverage] [--quick]
# Every check must pass. --quick runs only the checks that need no scratch database.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
if [[ "${1:-}" == "--coverage" ]]; then
	use_cluster coverage
	shift
fi
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

echo "grizzle doctor: PostgreSQL $PG_PIN_VERSION at $GRIZZLE_PG_PREFIX, cluster $GRIZZLE_PG_CLUSTER on port $PG_PORT"

if ! pg_running; then
	fail "cluster running" "start it with scripts/pg/ctl.sh$([[ "$GRIZZLE_PG_CLUSTER" == coverage ]] && echo " --coverage") start"
	exit 1
fi

check "server version is $PG_PIN_VERSION" "$PG_PIN_VERSION" \
	"$(dev "$PG_DEV_ROLE" -At -c "SHOW server_version")"
# OpenSSL is covered by the TLS checks; lz4 and zstd are probed through settings that require them.
check "built with lz4" "lz4" "$(dev "$PG_DEV_ROLE" -At -c "SET default_toast_compression = lz4" -c "SHOW default_toast_compression")"
check "built with zstd" "zstd" "$(admin_psql -d postgres -At -c "SET wal_compression = zstd" -c "SHOW wal_compression" 2>&1)"

check "jit is off by default" "off" \
	"$(dev "$PG_DEV_ROLE" -At -c "SHOW jit")"

check "max_pred_locks_per_transaction is 2048" "2048" \
	"$(dev "$PG_DEV_ROLE" -At -c "SHOW max_pred_locks_per_transaction")"

check "$PG_DEV_ROLE holds SET on lc_messages" "t" \
	"$(dev "$PG_DEV_ROLE" -At -c "SELECT has_parameter_privilege('lc_messages', 'SET')")"

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

if [[ "$GRIZZLE_PG_CLUSTER" == coverage ]]; then
	check "plpgsql_check is preloaded" "plpgsql_check" "$(admin_psql -d postgres -At -c "SHOW shared_preload_libraries" 2>&1)"
	check "the plpgsql_check profiler is on" "on" "$(dev "$PG_DEV_ROLE" -At -c "SHOW plpgsql_check.profiler")"
fi

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

# The probe's statements are its block, the IF and the two RETURNs, of which a call with 1 runs three; its branches
# are the IF's THEN and its implicit ELSE, of which it takes one. Reading needs the extension's functions, created in
# a transaction that rolls back.
if [[ "$GRIZZLE_PG_CLUSTER" == coverage ]]; then
	dev "$scratch" -c "CREATE FUNCTION doctor_probe(a int) RETURNS int LANGUAGE plpgsql AS \$\$ BEGIN IF a > 0 THEN RETURN 1; END IF; RETURN 0; END \$\$" -c "SELECT doctor_probe(1)" >/dev/null
	check "the profiler records statement and branch coverage" "0.75|0.5" \
		"$(admin_psql -d "$scratch" -At -c "BEGIN" -c "CREATE EXTENSION plpgsql_check" -c "SELECT plpgsql_coverage_statements('doctor_probe(int)'::regprocedure) || '|' || plpgsql_coverage_branches('doctor_probe(int)'::regprocedure)" -c "ROLLBACK" 2>&1)"
fi

[[ $failures -eq 0 ]] && echo "doctor: all checks passed" || echo "doctor: $failures check(s) failed"
exit $((failures > 0))
