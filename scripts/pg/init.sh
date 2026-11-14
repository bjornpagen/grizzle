#!/usr/bin/env bash
# Creates a local cluster of the pinned build: TLS material, configuration, the grizzle_dev owner role, and the
# template and scratch databases. The cluster is the one GRIZZLE_PG_CLUSTER names by its port, or the default when it
# is unset (lib.sh), and its state directory holds all of it.
#   init.sh [--force]
# An existing cluster is refused unless --force, which deletes it; so is a port taken on localhost.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_build
# The settings that size the cluster to this machine (lib.sh cluster_size), as postgresql.conf lines, read before an
# existing cluster is deleted.
sized="$(cluster_size | sed 's/ / = /')"

if [[ -d "$GRIZZLE_PG_DATA" ]]; then
	if [[ "${1:-}" != "--force" ]]; then
		echo "A cluster already exists at $GRIZZLE_PG_DATA; pass --force to delete and recreate it" >&2
		exit 1
	fi
	pg_running && "$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -m fast stop
	rm -rf "$GRIZZLE_PG_STATE"
fi
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

cat >> "$GRIZZLE_PG_DATA/postgresql.conf" <<EOF

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
# The table's own size is the machine's (test/support/substrate/shared.ts clusterPredicateLocks), so this is pinned
# apart from it.
max_pred_locks_per_relation = 1023
logging_collector = on
log_directory = '$GRIZZLE_PG_LOG'
log_filename = 'postgresql-%Y-%m-%d.log'
# The machine's time zone never reaches the cluster, which initdb would take it from: grizzle's logins pin no TimeZone,
# and its answers are the same under any (the ambient suites, test/support/ambient.ts).
timezone = 'UTC'
log_timezone = 'UTC'
# A connection lease for each of the network tier's workers, one per core, and each worker's database in shared buffers
# (test/support/substrate/shared.ts clusterSize).
$sized
EOF

cat > "$GRIZZLE_PG_DATA/pg_hba.conf" <<EOF
local   all   postgres                 peer map=admin
hostssl all   all        127.0.0.1/32  scram-sha-256
hostssl all   all        ::1/128       scram-sha-256
EOF

cat > "$GRIZZLE_PG_DATA/pg_ident.conf" <<EOF
admin   $(id -un)   postgres
EOF

"$(pg_bin pg_ctl)" -D "$GRIZZLE_PG_DATA" -l "$GRIZZLE_PG_LOG/startup.log" -w start >/dev/null

dev_password="$(cat "$GRIZZLE_PG_DEV_PASSWORD_FILE")"
admin_psql -d postgres <<SQL
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
admin_psql -d "$PG_TEMPLATE_DB" <<SQL
CREATE SCHEMA vector_ext AUTHORIZATION $PG_DEV_ROLE;
CREATE EXTENSION vector SCHEMA vector_ext;
SQL
admin_psql -d postgres -c "CREATE DATABASE $PG_DEV_ROLE OWNER $PG_DEV_ROLE TEMPLATE $PG_TEMPLATE_DB"
# A session inside the template would make every clone fail.
admin_psql -d postgres -c "ALTER DATABASE $PG_TEMPLATE_DB ALLOW_CONNECTIONS false"

# The connection lease's tables (test/support/substrate/shared.ts takeLease), owned by the owner in its own database.
# The cluster creates them, once, so no lease ever creates one while another does.
leased="$(lease_tables)"
tls_psql "$PG_DEV_ROLE" "$PG_DEV_ROLE" <<SQL
SELECT pg_catalog.format('CREATE TABLE public.%I ()', t) FROM pg_catalog.unnest(pg_catalog.string_to_array('${leased//$'\n'/ }', ' ')) AS t
\gexec
SQL

# Each live source's leader holds one slot and one walsender: raise both to the bound where the defaults fall short,
# which takes a restart.
bound="$(live_slot_bound)"
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

echo "Cluster ready: PostgreSQL $PG_PIN_VERSION on localhost:$PG_PORT (verify-full TLS, CA $GRIZZLE_PG_TLS/ca.crt)"
echo "Owner role $PG_DEV_ROLE; password in $GRIZZLE_PG_DEV_PASSWORD_FILE; template database $PG_TEMPLATE_DB"
echo "State directory $GRIZZLE_PG_STATE; GRIZZLE_PG_CLUSTER=$PG_PORT names it"
