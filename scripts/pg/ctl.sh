#!/usr/bin/env bash
# Day-to-day control of the family of local clusters GRIZZLE_PG_CLUSTER names by its port, or the default when it is
# unset (lib.sh): the members its family file records (packages/pg/src/family.ts), the first that cluster.
#   ctl.sh start | stop | status              every member
#   ctl.sh psql [database] [psql args...]    verify-full TLS as grizzle_dev, on the first member
#   ctl.sh admin [database] [psql args...]   bootstrap superuser over the socket, on the first member
#   ctl.sh reset                             drop test databases and every non-bootstrap role, on every member
#   ctl.sh env                               the first member's port and paths, one NAME=value line each
#   ctl.sh destroy                           stop every member of a named family and delete their state; never the default's
# A family with no family file is refused by every command that acts on its members: scripts/pg/init.sh records it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_build

# Runs `$@` once for each recorded member, its environment declared; refused, with a failing exit, when no family is
# recorded.
each_member() {
	local members port
	members="$(family_ports)" || exit 1
	for port in $members; do
		member_env "$port"
		"$@"
	done
	member_env "$FAMILY_PORT"
}

start_member() {
	pg_running || "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -l "$GRIZZLE_PG_LOG/startup.log" -w start >/dev/null
	echo "PostgreSQL $PG_PIN_VERSION running on localhost:$PG_PORT"
}
stop_member() {
	pg_running && "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -m fast -w stop >/dev/null
	echo "PostgreSQL on localhost:$PG_PORT stopped"
}
status_member() {
	if pg_running; then
		echo "PostgreSQL $PG_PIN_VERSION running on localhost:$PG_PORT"
	else
		echo "PostgreSQL on localhost:$PG_PORT stopped"
	fi
}
reset_member() {
	for db in $(admin_psql -d postgres -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'gz\_%'"); do
		admin_psql -d postgres -c "DROP DATABASE \"$db\" WITH (FORCE)"
	done
	for role in $(admin_psql -d postgres -At -c "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' AND rolname NOT IN ('postgres', '$PG_DEV_ROLE')"); do
		for db in $(admin_psql -d postgres -At -c "SELECT datname FROM pg_database WHERE datallowconn"); do
			admin_psql -d "$db" -c "DROP OWNED BY \"$role\"" >/dev/null
		done
		admin_psql -d postgres -c "DROP ROLE \"$role\""
	done
	echo "Test databases and non-bootstrap roles dropped on localhost:$PG_PORT"
}
destroy_member() {
	if [[ -d "$GRIZZLE_PG_DATA" ]]; then
		pg_running && "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -m immediate -w stop >/dev/null
	fi
	rm -rf "$GRIZZLE_PG_STATE"
	echo "Member on port $PG_PORT destroyed: $GRIZZLE_PG_STATE deleted"
}

case "${1:-}" in
	start)
		each_member start_member
		;;
	stop)
		each_member stop_member
		;;
	status)
		each_member status_member
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
		each_member reset_member
		;;
	env)
		pg_node cluster.ts
		;;
	destroy)
		if [[ "$FAMILY_PORT" == "$GRIZZLE_PG_DEFAULT_CLUSTER" ]]; then
			echo "The default family, on port $FAMILY_PORT, is shared and never destroyed; name yours with GRIZZLE_PG_CLUSTER=<port>" >&2
			exit 1
		fi
		if [[ ! -d "$GRIZZLE_PG_STATE" ]]; then
			echo "No cluster on port $FAMILY_PORT: $GRIZZLE_PG_STATE does not exist" >&2
			exit 1
		fi
		members="$(family_ports)" || exit 1
		for port in $members; do
			[[ "$port" == "$FAMILY_PORT" ]] && continue
			member_env "$port"
			destroy_member
		done
		member_env "$FAMILY_PORT"
		destroy_member
		;;
	*)
		sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2
		exit 2
		;;
esac
