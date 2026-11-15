#!/usr/bin/env bash
# REPIN: apply the repin draft to a cluster setup.sh migrated with the base tree, in two ways.
# (1) The lock probe: a clone of qti (qti_lockprobe, TEMPLATE qti) takes the draft's files in order through psql as
#     qti_admin, each transaction file inside BEGIN ISOLATION LEVEL SERIALIZABLE ... COMMIT with pg_locks read for its own
#     backend just before the COMMIT, so every lock the file holds until it ends is listed, by relation and mode
#     (locks.tsv: file, relation, mode, granted). The no-transaction file runs each statement alone. The clone is dropped.
# (2) The migration: `grizzle migrate importpar.config.ts` of the port tree (main's grizzle) on qti itself, every
#     statement logged with its duration and its CPU (log_min_duration_statement = 0, log_statement_stats), then
#     `grizzle drift importpar.config.ts`. migrate.log, drift.log; the server log is clusters/<tag>/log/.
# Usage: migrate.sh <tag> <port> <port tree> <draft folder name>
set -euo pipefail
tag=$1
port=$2
tree=$(readlink -f "$3")
draft=$4
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
secrets="$W/secrets/$tag"
out="$REPIN_OUT/$tag"
mkdir -p "$out"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
bash "$S/overlay.sh" "$tree"
folder="$tree/packages/data/qti-database/install/migrations/qti/$draft"
test -f "$folder/meta.json"
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
owner() {
	PGPASSWORD="$(cat "$secrets/qti_admin")" "$P/bin/psql" -X -q -At -F "$(printf "\t")" -v ON_ERROR_STOP=1 \
		-d "host=localhost port=$port dbname=$1 user=qti_admin sslmode=verify-full sslrootcert=$state/tls/ca.crt" \
		-v DBNAME="$1" -v ledger__learner=ledger__learner -v ledger__publisher=ledger__publisher "${@:2}"
}

admin -d postgres -c "DROP DATABASE IF EXISTS qti_lockprobe" -c "CREATE DATABASE qti_lockprobe TEMPLATE qti OWNER qti_admin"
: > "$out/locks.tsv"
for f in "$folder"/0*.sql; do
	name=$(basename "$f")
	s=$(date +%s.%N)
	if head -1 "$f" | grep -q '^-- grizzle: no-transaction'; then
		owner qti_lockprobe -f "$f" > /dev/null
	else
		owner qti_lockprobe > /dev/null <<SQL
BEGIN ISOLATION LEVEL SERIALIZABLE;
\i $f
\o | sed 's/^/$name\t/' >> $out/locks.tsv
SELECT CASE l.locktype WHEN 'relation' THEN coalesce(n.nspname || '.' || c.relname, l.relation::text) ELSE l.locktype END, l.mode, l.granted
FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE l.pid = pg_backend_pid() AND l.locktype IN ('relation', 'advisory', 'object')
ORDER BY 1, 2;
\o
COMMIT;
SQL
	fi
	echo "lockprobe $name $(echo "$(date +%s.%N) - $s" | bc) s" | tee -a "$out/lockprobe.log"
done
admin -d postgres -c "DROP DATABASE qti_lockprobe"

admin -d postgres <<SQL
ALTER SYSTEM SET log_min_duration_statement = 0;
ALTER SYSTEM SET log_statement_stats = on;
SELECT pg_reload_conf();
SQL
date -u +"start %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" > "$out/migrate-when.txt"
rc=0
(
	cd "$tree/packages/data/qti-database"
	IMPORTPAR_PORT=$port IMPORTPAR_CA="$state/tls/ca.crt" IMPORTPAR_SECRETS="$secrets" \
		/usr/bin/time -f "wall %e s, user %U s, sys %S s, maxrss %M kB" node --disable-proto=delete --disable-sigusr1 \
		"$tree/vendor/grizzle/packages/grizzle/src/cli/main.ts" migrate importpar.config.ts
) > "$out/migrate.log" 2>&1 || rc=$?
echo "exit $rc" >> "$out/migrate.log"
date -u +"end %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/migrate-when.txt"
admin -d postgres <<SQL
ALTER SYSTEM RESET log_min_duration_statement;
ALTER SYSTEM RESET log_statement_stats;
SELECT pg_reload_conf();
SQL
bash "$S/passwords.sh" "$tag" "$port"
(
	cd "$tree/packages/data/qti-database"
	IMPORTPAR_PORT=$port IMPORTPAR_CA="$state/tls/ca.crt" IMPORTPAR_SECRETS="$secrets" node --disable-proto=delete \
		--disable-sigusr1 "$tree/vendor/grizzle/packages/grizzle/src/cli/main.ts" drift importpar.config.ts
) > "$out/drift.log" 2>&1 || echo "drift exit $?" >> "$out/drift.log"
cat "$out/lockprobe.log" "$out/migrate-when.txt" "$out/migrate.log" "$out/drift.log"
[ "$rc" = 0 ]
