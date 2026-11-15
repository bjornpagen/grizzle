#!/usr/bin/env bash
# The ssi-summary experiment (README.md): a lone SERIALIZABLE writer fails with 40001 against its own earlier write
# once PostgreSQL's SSI has summarized that write while another transaction holds the cluster's horizon. Run it on a
# private family only, never the default cluster: it fills the cluster's pool of finished SERIALIZABLE transactions.
#   GRIZZLE_PG_CLUSTER=<port> nice -n 19 packages/experiments/ssi-summary/run.sh
# Exits 0 when PostgreSQL behaves as README.md states (the shrink fails as a pivot with a conflict out to the write,
# and the same sequence with no holder commits), 1 otherwise: the verdict that ends the experiment.
set -uo pipefail
if [[ -z "${GRIZZLE_PG_CLUSTER:-}" ]]; then
	echo "name a private family with GRIZZLE_PG_CLUSTER=<port>: this run fills the cluster's SSI state" >&2
	exit 2
fi
source "$(dirname "$0")/../../../scripts/pg/lib.sh"
db=gz_ssi_summary
q() { "$(pg_bin psql)" -X -h "$GRIZZLE_PG_SOCKET" -p "$PG_PORT" -U postgres "$@"; }
q -d postgres -qc "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db"
q -d $db -qc "CREATE TABLE o (id int PRIMARY KEY, n int NOT NULL)" -c "CREATE TABLE m (id int PRIMARY KEY, v int NOT NULL)" -c "CREATE TABLE f (x int)"
# The pool of SERIALIZABLEXACTs: ten per backend slot and prepared transaction (predicate.c InitPredicateLocks).
pool=$(q -d $db -Atc "SELECT (current_setting('max_connections')::int + current_setting('autovacuum_worker_slots')::int + current_setting('max_worker_processes')::int + current_setting('max_wal_senders')::int + 1 + current_setting('max_prepared_transactions')::int) * 10")
fillers() {
	local f
	f=$(mktemp)
	for ((i = 0; i < $1; i++)); do echo "BEGIN ISOLATION LEVEL SERIALIZABLE; INSERT INTO f VALUES (1); COMMIT;"; done >"$f"
	echo "$f"
}
fill=$(fillers $((pool + pool / 4)))
half=$(fillers $((pool / 2)))
rest=$(fillers $((pool / 2 + pool / 8)))
# The single writer's three transactions, then its shrink; the shrink's output is the verdict's evidence.
sequence() {
	q -d $db -qAt -c "BEGIN ISOLATION LEVEL SERIALIZABLE" -c "INSERT INTO o VALUES (0, 5000)" -c "INSERT INTO m SELECT g, 0 FROM pg_catalog.generate_series(1, 5000) AS g" -c "COMMIT"
	q -d $db -q -f "$half" >/dev/null
	q -d $db -qAt -c "BEGIN ISOLATION LEVEL SERIALIZABLE" -c "SELECT n FROM o WHERE id = 0" -c "UPDATE m SET v = v + 1" -c "COMMIT" >/dev/null
	q -d $db -q -f "$rest" >/dev/null
	q -d $db -qAt -c "BEGIN ISOLATION LEVEL SERIALIZABLE" -c "UPDATE o SET n = n - 1 WHERE id = 0" -c "DELETE FROM m" -c "COMMIT" 2>&1
}
echo "# $(date -u) family $GRIZZLE_PG_CLUSTER, pool about $pool, $(q -d $db -Atc 'SELECT version()')"
printf "BEGIN ISOLATION LEVEL SERIALIZABLE;\nSELECT pg_catalog.pg_current_xact_id();\nSELECT pg_catalog.pg_sleep(86400);\n" | q -d $db -qAt >/dev/null 2>&1 &
holder=$!
q -d $db -q -f "$fill" >/dev/null
held=$(sequence)
echo "## with a writing transaction held open: $held"
q -d postgres -qAtc "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = '$db' AND query LIKE '%pg_sleep%'" >/dev/null
wait $holder 2>/dev/null
q -d $db -qc "TRUNCATE m, o"
released=$(sequence)
echo "## with no transaction held open: $released"
rm -f "$fill" "$half" "$rest"
q -d postgres -qc "DROP DATABASE $db WITH (FORCE)"
if grep -q "Canceled on identification as a pivot, with conflict out to old committed transaction" <<<"$held" && ! grep -q ERROR <<<"$released"; then
	echo "PostgreSQL fails the lone writer as README.md states"
	exit 0
fi
echo "PostgreSQL no longer fails the lone writer: the experiment's verdict is in"
exit 1
