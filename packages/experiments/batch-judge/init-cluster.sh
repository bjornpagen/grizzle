#!/usr/bin/env bash
# batch-judge (copied from edullm-repin, FAMWRITE, BULKLOAD, IMPORTPAR): one unpatched PostgreSQL 19rc1 cluster (RC1TARGET's prefix, read-only), set as edullm-qti-db's
# default.postgres19 group sets it for db.r7g.2xlarge (8 vCPU, 64 GiB) where it matters, plus rds.logical_replication=1
# (wal_level logical). RC1TARGET's init-cluster.sh with the class-dependent values recomputed by RDS's formulas over
# DBInstanceClassMemory = 64 GiB less the reserve t4g.medium shows (4 GiB - 116338*32768 B) = 68236673024 B (estimate):
#   shared_buffers {DBInstanceClassMemory/32768} = 2082418 x 8kB (15.9 GiB); effective_cache_size {/16384} = 4164836 x 8kB;
#   maintenance_work_mem GREATEST({DBInstanceClassMemory*1024/63963136},65536) = 1092416 kB;
#   autovacuum_work_mem {DBInstanceClassMemory/32768} kB = 2082418 kB (t4g shows 116338 kB = the same formula);
#   max_connections LEAST({DBInstanceClassMemory/9531392},5000) = 5000;
#   max_worker_processes GREATEST(vCPU*2,8) = 16; max_parallel_workers GREATEST(vCPU/2,8) = 8.
# The postmaster runs in a systemd user scope with CPUQuota=800% (cgroup v2 cpu.max 800000 100000), so the cluster
# uses at most 8 CPUs' worth of time, as the instance's 8 vCPU; the scope's cpu.stat records its use and throttling.
# Usage: init-cluster.sh <prefix> <state dir> <port> <scope name>
set -euo pipefail
prefix=$1
state=$2
port=$3
scope=$4
data="$state/data"
tls="$state/tls"
sock="$state/socket"
log="$state/log"

test ! -e "$state"
mkdir -p "$tls" "$sock" "$log"
chmod 700 "$state"
(
	cd "$tls"
	openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 -days 30 \
		-subj "/CN=batch-judge CA" -keyout ca.key -out ca.crt 2>/dev/null
	openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 \
		-subj "/CN=localhost" -keyout server.key -out server.csr 2>/dev/null
	printf "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n" > server.ext
	openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 30 \
		-extfile server.ext -out server.crt 2>/dev/null
	rm -f server.csr server.ext ca.srl
	chmod 600 ./*.key
)

"$prefix/bin/initdb" -D "$data" -U postgres -E UTF8 --locale-provider=libc --locale=en_US.UTF-8 \
	--auth-local=peer --auth-host=reject >/dev/null

cat >> "$data/postgresql.conf" <<EOF

# batch-judge (from edullm-repin, FAMWRITE, BULKLOAD, IMPORTPAR): edullm-qti-db's settings (default.postgres19 on db.r7g.2xlarge, rds.logical_replication=1, engine 19.20261015).
port = $port
listen_addresses = 'localhost'
unix_socket_directories = '$sock'
ssl = on
ssl_cert_file = '$tls/server.crt'
ssl_key_file = '$tls/server.key'
ssl_min_protocol_version = 'TLSv1.3'
password_encryption = 'scram-sha-256'
scram_iterations = 4096
logging_collector = on
log_directory = '$log'
log_filename = 'postgresql-%Y-%m-%d.log'
log_line_prefix = '%m:%r:%u@%d:[%p]:%e: '
log_checkpoints = on
log_lock_waits = on
log_autovacuum_min_duration = 10000
log_autoanalyze_min_duration = 10000
timezone = 'UTC'
log_timezone = 'UTC'
wal_level = logical
max_connections = 5000
superuser_reserved_connections = 3
reserved_connections = 2
shared_buffers = 2082418
effective_cache_size = 4164836
work_mem = 4096
maintenance_work_mem = 1092416
autovacuum_work_mem = 2082418
random_page_cost = 4
effective_io_concurrency = 16
io_method = sync
jit = off
plan_cache_mode = auto
max_pred_locks_per_transaction = 64
max_pred_locks_per_relation = -2
max_pred_locks_per_page = 2
max_locks_per_transaction = 128
max_prepared_transactions = 0
max_worker_processes = 16
max_parallel_workers = 8
max_parallel_workers_per_gather = 2
max_replication_slots = 20
max_wal_senders = 35
max_wal_size = 6144MB
min_wal_size = 192MB
wal_keep_size = 2048MB
wal_compression = zstd
default_toast_compression = lz4
checkpoint_timeout = 300
checkpoint_completion_target = 0.9
synchronous_commit = on
huge_pages = off
idle_in_transaction_session_timeout = 86400000
client_connection_check_interval = 60000
max_stack_depth = 6144kB
autovacuum = on
autovacuum_max_workers = 3
autovacuum_worker_slots = 16
autovacuum_naptime = 15
autovacuum_analyze_scale_factor = 0.05
autovacuum_vacuum_scale_factor = 0.1
autovacuum_vacuum_cost_limit = 200
vacuum_cost_page_miss = 5
vacuum_buffer_usage_limit = 953kB
track_functions = pl
track_io_timing = on
track_wal_io_timing = on
track_cost_delay_timing = on
track_activity_query_size = 4096
compute_query_id = auto
shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = -1
EOF

cat > "$data/pg_hba.conf" <<EOF
local   all   postgres                 peer map=admin
hostssl all   all        127.0.0.1/32  scram-sha-256
hostssl all   all        ::1/128       scram-sha-256
EOF
cat > "$data/pg_ident.conf" <<EOF
admin   $(id -un)   postgres
EOF

systemd-run --user --scope --quiet --unit="$scope" -p CPUQuota=800% \
	"$prefix/bin/pg_ctl" -D "$data" -l "$log/startup.log" -w start >/dev/null
"$prefix/bin/psql" -X -q -v ON_ERROR_STOP=1 -h "$sock" -p "$port" -U postgres -d postgres -At \
	-c "SELECT version()" -c "SHOW shared_buffers" -c "SHOW max_connections" -c "SHOW wal_level"
