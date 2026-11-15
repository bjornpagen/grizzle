#!/usr/bin/env bash
# REPIN: one psql script that prices the draft on a database in a single transaction it rolls back, for push-db to run
# on production before applying it. Every file in order inside BEGIN ISOLATION LEVEL SERIALIZABLE ... ROLLBACK, with
# \timing on, so each statement prints its own duration. The no-transaction file cannot run in a transaction, so its
# DROP INDEX CONCURRENTLY IF EXISTS and CREATE [UNIQUE] INDEX CONCURRENTLY run as plain DROP INDEX IF EXISTS and
# CREATE [UNIQUE] INDEX. A plain build reads the heap once, where a concurrent one reads it twice and waits out older
# transactions, and it holds SHARE on its table, which blocks writes, until the ROLLBACK. Before the ROLLBACK the
# script prints every lock the transaction holds, by relation and mode, and the transaction's own WAL.
# The roles are psql variables, as grizzle migrate fills them: run it as the migration identity with
#   psql -X -v ON_ERROR_STOP=1 -v DBNAME=<database> -v ledger__learner=<role> -v ledger__publisher=<role> -f price.sql
# (the role names are the stems under the connection's rolePrefix; with none, the stems themselves).
# Usage: price.sh <draft folder> > price.sql
set -euo pipefail
folder=$1
echo "-- grizzle draft $(basename "$folder"), priced in one transaction that rolls back (REPIN price.sh)."
echo '\set ON_ERROR_STOP 1'
echo '\timing on'
echo 'BEGIN ISOLATION LEVEL SERIALIZABLE;'
echo "SELECT pg_current_wal_insert_lsn() AS price_start_lsn \\gset"
for f in "$folder"/0*.sql; do
	echo "\\echo == $(basename "$f")"
	if head -n 1 "$f" | grep -q '^-- grizzle: no-transaction'; then
		sed -e '1d' -e 's/DROP INDEX CONCURRENTLY IF EXISTS/DROP INDEX IF EXISTS/' \
			-e 's/^CREATE UNIQUE INDEX CONCURRENTLY /CREATE UNIQUE INDEX /' -e 's/^CREATE INDEX CONCURRENTLY /CREATE INDEX /' "$f"
	else
		cat "$f"
	fi
	echo
done
cat <<'SQL'
\echo == locks held at the end
SELECT l.mode, count(*) AS relations,
  string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY c.relpages DESC) FILTER (WHERE c.relkind IN ('r', 'p')) AS tables_largest_first
FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND n.nspname NOT IN ('pg_catalog', 'pg_toast')
GROUP BY l.mode ORDER BY count(*) DESC;
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'price_start_lsn')) AS wal_written;
ROLLBACK;
SQL
