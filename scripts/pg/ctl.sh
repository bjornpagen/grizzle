#!/usr/bin/env bash
# Day-to-day control of the local cluster GRIZZLE_PG_CLUSTER names by its port, or the default when it is unset (lib.sh).
#   ctl.sh start | stop | status
#   ctl.sh psql [database] [psql args...]    verify-full TLS as grizzle_dev
#   ctl.sh admin [database] [psql args...]   bootstrap superuser over the socket
#   ctl.sh reset                             drop test databases and every non-bootstrap role
#   ctl.sh env                               the cluster's port and paths, one NAME=value line each
#   ctl.sh destroy                           stop a named cluster and delete its state directory; never the default
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_build

case "${1:-}" in
	start)
		pg_running || "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -l "$GRIZZLE_PG_LOG/startup.log" -w start >/dev/null
		echo "PostgreSQL $PG_PIN_VERSION running on localhost:$PG_PORT"
		;;
	stop)
		pg_running && "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -m fast -w stop >/dev/null
		echo "PostgreSQL stopped"
		;;
	status)
		if pg_running; then
			echo "PostgreSQL $PG_PIN_VERSION running on localhost:$PG_PORT"
		else
			echo "PostgreSQL stopped"
		fi
		;;
	psql)
		shift; db="${1:-$PG_DEV_ROLE}"; shift || true
		tls_psql "$PG_DEV_ROLE" "$db" "$@"
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
	env)
		repo_node scripts/pg/cluster.ts
		;;
	destroy)
		if [[ "$PG_PORT" == "$GRIZZLE_PG_DEFAULT_CLUSTER" ]]; then
			echo "The default cluster, on port $PG_PORT, is shared and never destroyed; name yours with GRIZZLE_PG_CLUSTER=<port>" >&2
			exit 1
		fi
		if [[ ! -d "$GRIZZLE_PG_STATE" ]]; then
			echo "No cluster on port $PG_PORT: $GRIZZLE_PG_STATE does not exist" >&2
			exit 1
		fi
		pg_running && "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -m immediate -w stop >/dev/null
		rm -rf "$GRIZZLE_PG_STATE"
		echo "Cluster on port $PG_PORT destroyed: $GRIZZLE_PG_STATE deleted"
		;;
	*)
		sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2
		exit 2
		;;
esac
