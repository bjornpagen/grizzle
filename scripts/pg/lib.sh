# Shared helpers for scripts/pg. Sourced, never executed.
# shellcheck shell=bash
source "$(dirname "${BASH_SOURCE[0]}")/pin.env"

# The cluster a script acts on. main is the development cluster every test and benchmark uses; coverage is a second
# cluster of the same build that preloads plpgsql_check with its profiler on, for PL/pgSQL coverage.
use_cluster() {
	case "$1" in
		main) ;;
		coverage)
			PG_PORT=$PG_COVERAGE_PORT
			GRIZZLE_PG_STATE=$GRIZZLE_PG_COVERAGE_STATE
			GRIZZLE_PG_DATA=$GRIZZLE_PG_STATE/data
			GRIZZLE_PG_TLS=$GRIZZLE_PG_STATE/tls
			GRIZZLE_PG_LOG=$GRIZZLE_PG_STATE/log
			;;
		*)
			echo "unknown cluster $1" >&2
			exit 2
			;;
	esac
	GRIZZLE_PG_CLUSTER=$1
	GRIZZLE_PG_SOCKET="$GRIZZLE_PG_STATE/socket"
	GRIZZLE_PG_DEV_PASSWORD_FILE="$GRIZZLE_PG_STATE/$PG_DEV_ROLE.password"
}
use_cluster main

# Every cluster use_cluster selects. All of them run from the one build at $GRIZZLE_PG_PREFIX.
PG_CLUSTERS="main coverage"

pg_bin() { echo "$GRIZZLE_PG_PREFIX/bin/$1"; }

# The stamps of the build at the prefix $1, which build.sh writes last. The core stamp holds the patch set the build
# was made with, so a changed set rebuilds.
core_stamp() { echo "$1/.grizzle-build-$PG_PIN_COMMIT"; }
plpgsql_check_stamp() { echo "$1/.grizzle-plpgsql_check-$PLPGSQL_CHECK_PIN_TARBALL_SHA256"; }

require_build() {
	if [[ ! -f "$(core_stamp "$GRIZZLE_PG_PREFIX")" ]]; then
		echo "PostgreSQL $PG_PIN_VERSION is not built; run scripts/pg/build.sh" >&2
		exit 1
	fi
	if [[ "$GRIZZLE_PG_CLUSTER" == coverage && ! -f "$(plpgsql_check_stamp "$GRIZZLE_PG_PREFIX")" ]]; then
		echo "plpgsql_check $PLPGSQL_CHECK_PIN_VERSION is not built; run scripts/pg/build.sh" >&2
		exit 1
	fi
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
