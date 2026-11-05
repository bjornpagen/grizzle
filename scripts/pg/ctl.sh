#!/usr/bin/env bash
# Day-to-day control of a local cluster: the main one, or with --coverage the coverage one.
#   ctl.sh [--coverage] start | stop | status
#   ctl.sh [--coverage] psql [database] [psql args...]    verify-full TLS as grizzle_dev
#   ctl.sh [--coverage] admin [database] [psql args...]   bootstrap superuser over the socket
#   ctl.sh [--coverage] admin-env [database]              print DATABASE_URL for the bootstrap superuser over the socket
#   ctl.sh [--coverage] reset                             drop test databases and every non-bootstrap role
set -euo pipefail
source "$(dirname "$0")/lib.sh"
if [[ "${1:-}" == "--coverage" ]]; then
	use_cluster coverage
	shift
fi
require_build

encode() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

case "${1:-}" in
	start)
		pg_running || "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -l "$GRIZZLE_PG_LOG/startup.log" -w start >/dev/null
		echo "PostgreSQL $PG_PIN_VERSION ($GRIZZLE_PG_CLUSTER) running on localhost:$PG_PORT"
		;;
	stop)
		pg_running && "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -m fast -w stop >/dev/null
		echo "PostgreSQL ($GRIZZLE_PG_CLUSTER) stopped"
		;;
	status)
		if pg_running; then
			echo "PostgreSQL $PG_PIN_VERSION ($GRIZZLE_PG_CLUSTER) running on localhost:$PG_PORT"
		else
			echo "PostgreSQL ($GRIZZLE_PG_CLUSTER) stopped"
		fi
		;;
	psql)
		shift; db="${1:-$PG_DEV_ROLE}"; shift || true
		tls_psql "$PG_DEV_ROLE" "$db" "$@"
		;;
	admin-env)
		db="${2:-postgres}"
		printf 'export DATABASE_URL=%q\n' \
			"postgresql://postgres@localhost:$PG_PORT/$(encode "$db")?host=$(encode "$GRIZZLE_PG_SOCKET")"
		;;
	admin)
		shift; db="${1:-postgres}"; shift || true
		admin_psql -d "$db" "$@"
		;;
	reset)
		for db in $(admin_psql -d postgres -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'gz\_%'"); do
			admin_psql -d postgres -c "DROP DATABASE \"$db\" WITH (FORCE)"
		done
		for role in $(admin_psql -d postgres -At -c "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' AND rolname NOT IN ('postgres', '$PG_DEV_ROLE')"); do
			for db in $(admin_psql -d postgres -At -c "SELECT datname FROM pg_database WHERE datallowconn"); do
				admin_psql -d "$db" -c "DROP OWNED BY \"$role\"" >/dev/null
			done
			admin_psql -d postgres -c "DROP ROLE \"$role\""
		done
		echo "Test databases and non-bootstrap roles dropped"
		;;
	*)
		sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' >&2
		exit 2
		;;
esac
