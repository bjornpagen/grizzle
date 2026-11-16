#!/usr/bin/env bash
# Creates the family of local clusters of the pinned build GRIZZLE_PG_CLUSTER names by its port, or the default when it
# is unset (lib.sh): its first member on that port, then each further member the family's size asks for
# (packages/pg/src/family.ts familyMembers) on a port free at that moment, none derived from another, and the family
# file that records them all, which every other reader of the family reads. Each member gets TLS material,
# configuration sized to its share of the machine, the grizzle_dev owner role, and the template and scratch databases,
# in a state directory of its own.
#   init.sh [--force | --adopt]
# An existing family is refused, recorded or not: a first member's state directory there is someone's cluster.
# --force deletes every member the family file records, and the first, then creates the family anew. --adopt keeps the
# running members there are, their data untouched: a first member that predates the family file, or the members a
# family file records from before the family's size grew. It sizes each to its share of the machine, restarting it,
# creates the further members the size asks for and records the family: how a cluster made before families, the
# default one among them, becomes one, and how a family grows, by an operator who knows they are theirs. A family
# recorded with more members than its size is refused, and so is a port taken on localhost.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_build
# The settings that size each member to its share of this machine (lib.sh cluster_size), a setting and its value a line,
# and as postgresql.conf lines, read before an existing family is deleted.
sized_settings="$(cluster_size)"
sized="${sized_settings// / = }"
# The settings every member holds exactly, whatever the machine (lib.sh cluster_settings), in both forms.
fixed_settings="$(cluster_settings)"
fixed="${fixed_settings// / = }"
size="$(family_cli size)"
family_file="$(family_cli file)"

# Stops the member whose environment is declared and deletes its state directory, when it has one.
delete_member() {
	if [[ -d "$GRIZZLE_PG_DATA" ]]; then
		pg_running && "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -m fast stop
	fi
	rm -rf "$GRIZZLE_PG_STATE"
}

mode="${1:-create}"
case "$mode" in
	create)
		if [[ -f "$family_file" || -d "$GRIZZLE_PG_DATA" ]]; then
			echo "A cluster already exists at $GRIZZLE_PG_STATE; pass --force to delete and recreate its family, or --adopt to keep a cluster made before families as the family's first member" >&2
			exit 1
		fi
		;;
	--force)
		if [[ -f "$family_file" ]]; then
			recorded="$(family_ports)"
			for port in $recorded; do
				member_env "$port"
				delete_member
			done
			member_env "$FAMILY_PORT"
		fi
		delete_member
		;;
	--adopt)
		kept=("$FAMILY_PORT")
		if [[ -f "$family_file" ]]; then
			if ! recorded="$(family_cli recorded)"; then
				head -n 1 <<<"$recorded" >&2
				exit 1
			fi
			mapfile -t kept <<<"$recorded"
			if ((${#kept[@]} >= size)); then
				echo "The family recorded at $family_file has ${#kept[@]} member(s) of its $size: nothing to adopt" >&2
				exit 1
			fi
		fi
		for port in "${kept[@]}"; do
			member_env "$port"
			if ! pg_running; then
				echo "No running cluster at $GRIZZLE_PG_DATA to adopt: --adopt keeps running members as they are" >&2
				exit 1
			fi
		done
		member_env "$FAMILY_PORT"
		;;
	*)
		sed -n '2,/^set /p' "$0" | grep '^#' | sed 's/^# \{0,1\}//' >&2
		exit 2
		;;
esac

# Creates the member whose environment is declared, on its port, which must be free.
create_member() {
	require_port_free

	mkdir -p "$GRIZZLE_PG_TLS" "$GRIZZLE_PG_LOG" "$GRIZZLE_PG_SOCKET"
	chmod 700 "$GRIZZLE_PG_STATE"

	# The unrelated CA exists for the refusal checks.
	(
		cd "$GRIZZLE_PG_TLS"
		openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 -days 3650 \
			-subj "/CN=grizzle local development CA" -keyout ca.key -out ca.crt 2>/dev/null
		openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 -days 3650 \
			-subj "/CN=grizzle unrelated CA" -keyout wrong-ca.key -out wrong-ca.crt 2>/dev/null
		openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 \
			-subj "/CN=localhost" -keyout server.key -out server.csr 2>/dev/null
		printf "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n" > server.ext
		openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 3650 \
			-extfile server.ext -out server.crt 2>/dev/null
		rm -f server.csr server.ext ca.srl
		chmod 600 ./*.key
	)

	openssl rand -hex 24 > "$GRIZZLE_PG_DEV_PASSWORD_FILE"
	chmod 600 "$GRIZZLE_PG_DEV_PASSWORD_FILE"

	"$(pg_bin initdb)" -D "$GRIZZLE_PG_DATA" -U postgres -E UTF8 \
		--locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C.UTF-8 \
		--auth-local=peer --auth-host=reject >/dev/null

	cat >> "$GRIZZLE_PG_DATA/postgresql.conf" <<-EOF

	# grizzle local development (scripts/pg/init.sh). Everything else is the PostgreSQL
	# $PG_PIN_VERSION default, including jit = off server-wide.
	port = $PG_PORT
	listen_addresses = 'localhost'
	unix_socket_directories = '$GRIZZLE_PG_SOCKET'
	ssl = on
	ssl_cert_file = '$GRIZZLE_PG_TLS/server.crt'
	ssl_key_file = '$GRIZZLE_PG_TLS/server.key'
	ssl_min_protocol_version = 'TLSv1.3'
	password_encryption = 'scram-sha-256'
	track_io_timing = on
	# Every installation with live reads decodes the WAL (logical decoding): migrate refuses one below logical.
	wal_level = logical
	# A transaction's page locks promote to its relation's where production's do: past 1023, what PostgreSQL's default of -2
	# gives README's recommended max_pred_locks_per_transaction = 2048 (predicate.c MaxPredicateChildLocks, 2048 / 2 - 1).
	# The table's own size is the machine's (packages/pg/src/size.ts clusterPredicateLocks), so this is pinned
	# apart from it.
	max_pred_locks_per_relation = 1023
	logging_collector = on
	log_directory = '$GRIZZLE_PG_LOG'
	log_filename = 'postgresql-%Y-%m-%d.log'
	# The machine's time zone never reaches the cluster, which initdb would take it from: grizzle's logins pin no TimeZone,
	# and its answers are the same under any (the ambient suites, test/support/ambient.ts).
	timezone = 'UTC'
	log_timezone = 'UTC'
	# A connection lease for each network worker this member serves (its share of the cores over the family's members),
	# and each such worker's database in shared buffers (packages/pg/src/size.ts clusterSize, family.ts memberShare).
	$sized
	# The settings every member holds exactly, whatever the machine (packages/pg/src/settings.ts clusterSettings): among
	# them a running statement's poll of its client's socket, so a backend whose client died mid-statement ends at its
	# next poll and lets go of its transaction id.
	$fixed
	EOF

	cat > "$GRIZZLE_PG_DATA/pg_hba.conf" <<-EOF
	local   all   postgres                 peer map=admin
	hostssl all   all        127.0.0.1/32  scram-sha-256
	hostssl all   all        ::1/128       scram-sha-256
	EOF

	cat > "$GRIZZLE_PG_DATA/pg_ident.conf" <<-EOF
	admin   $(id -un)   postgres
	EOF

	"$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -l "$GRIZZLE_PG_LOG/startup.log" -w start >/dev/null

	dev_password="$(cat "$GRIZZLE_PG_DEV_PASSWORD_FILE")"
	admin_psql -d postgres <<-SQL
	-- REPLICATION, so the migration identity gives each installation's decoder login its replication right, which only a
	-- role holding it may give.
	CREATE ROLE $PG_DEV_ROLE LOGIN CREATEDB CREATEROLE REPLICATION PASSWORD '$dev_password';
	-- deadlock_timeout is superuser-only; every test database stores it low as its own default, so the concurrency
	-- driver's wait for each blocked step's deadlock check is short.
	GRANT SET ON PARAMETER deadlock_timeout TO $PG_DEV_ROLE;
	-- The benchmarks read the deferred-event queue's memory context, which needs pg_read_all_stats. The migration
	-- identity inherits none of it: it may SET ROLE to it for that one reading and grant it the same way to a measured
	-- login.
	GRANT pg_read_all_stats TO $PG_DEV_ROLE WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
	CREATE DATABASE $PG_TEMPLATE_DB OWNER $PG_DEV_ROLE TEMPLATE template0 ENCODING 'UTF8'
		LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8' IS_TEMPLATE true;
	SQL

	# pgvector is not a trusted extension, so a non-superuser migration identity cannot create it; the template carries
	# it, created by the administrator, and Setup's "create if absent" finds it present.
	admin_psql -d "$PG_TEMPLATE_DB" <<-SQL
	CREATE SCHEMA vector_ext AUTHORIZATION $PG_DEV_ROLE;
	CREATE EXTENSION vector SCHEMA vector_ext;
	SQL
	admin_psql -d postgres -c "CREATE DATABASE $PG_DEV_ROLE OWNER $PG_DEV_ROLE TEMPLATE $PG_TEMPLATE_DB"
	# A session inside the template would make every clone fail.
	admin_psql -d postgres -c "ALTER DATABASE $PG_TEMPLATE_DB ALLOW_CONNECTIONS false"

	# What the connection lease asks of the member (lib.sh lease_facts): its live source bound, then its tables.
	leased_facts="$(lease_facts)"

	# The connection lease's tables (test/support/substrate/shared.ts takeLease), owned by the owner in its own database.
	# The cluster creates them, once, so no lease ever creates one while another does.
	leased="$(tail -n +2 <<<"$leased_facts")"
	tls_psql "$PG_DEV_ROLE" "$PG_DEV_ROLE" <<-SQL
	SELECT pg_catalog.format('CREATE TABLE public.%I ()', t) FROM pg_catalog.unnest(pg_catalog.string_to_array('${leased//$'\n'/ }', ' ')) AS t
	\gexec
	SQL

	# Each live source's leader holds one slot and one walsender: raise both to the bound where the defaults fall short,
	# which takes a restart.
	bound="$(head -n 1 <<<"$leased_facts")"
	raised=0
	for setting in max_replication_slots max_wal_senders; do
		if (($(admin_psql -d postgres -At -c "SHOW $setting") < bound)); then
			admin_psql -d postgres -c "ALTER SYSTEM SET $setting = $bound"
			raised=1
		fi
	done
	if ((raised)); then
		"$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -l "$GRIZZLE_PG_LOG/startup.log" -w restart >/dev/null
	fi

	echo "Member ready: PostgreSQL $PG_PIN_VERSION on localhost:$PG_PORT (verify-full TLS, CA $GRIZZLE_PG_TLS/ca.crt), state directory $GRIZZLE_PG_STATE"
}

# Sizes the running member whose environment is declared to its share of this machine, the settings create_member
# writes (lib.sh cluster_size), gives it the settings every member holds (lib.sh cluster_settings), and restarts it,
# since shared_buffers and max_connections take effect only at a start. So a family that grows keeps the memory it had,
# divided over more members, never a kept member's old share beside the new members' smaller ones.
resize_member() {
	local setting value
	while read -r setting value; do
		admin_psql -d postgres -c "ALTER SYSTEM SET $setting = $value"
	done <<<"$sized_settings"$'\n'"$fixed_settings"
	"$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -l "$GRIZZLE_PG_LOG/startup.log" -w restart >/dev/null
	echo "Member sized to its share: PostgreSQL $PG_PIN_VERSION on localhost:$PG_PORT"
}

members=("$FAMILY_PORT")
if [[ "$mode" == --adopt ]]; then
	members=("${kept[@]}")
	for port in "${kept[@]}"; do
		member_env "$port"
		resize_member
	done
else
	create_member
fi
while ((${#members[@]} < size)); do
	member_env "$(family_cli free "${members[@]}")"
	create_member
	members+=("$PG_PORT")
done
member_env "$FAMILY_PORT"
family_cli record "${members[@]}"

echo "Family ready: ${#members[@]} member(s) on localhost:${members[*]}, recorded in $family_file"
echo "Owner role $PG_DEV_ROLE in each; template database $PG_TEMPLATE_DB; GRIZZLE_PG_CLUSTER=$FAMILY_PORT names the family"
