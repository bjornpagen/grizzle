#!/usr/bin/env bash
# The ssi-summary experiment (README.md): a lone SERIALIZABLE writer fails with 40001 against its own earlier write
# once PostgreSQL's SSI has summarized that write while another transaction holds the cluster's horizon. It runs on a
# cluster of its own, the workbench's postgres@grizzle-ssi-summary (socket $XDG_RUNTIME_DIR/postgresql-grizzle-ssi-summary,
# trust for the account), never the shared one: it fills the cluster's pool of finished SERIALIZABLE transactions. The
# cluster runs only while the script holds it: the script runs itself again under the account's pg-held, which keeps
# the cluster up for exactly as long as the script runs (the workbench starts no cluster unheld, beefy da1e9fc).
#   packages/experiments/ssi-summary/run.sh
# Exits 0 when PostgreSQL behaves as README.md states (the shrink fails as a pivot with a conflict out to the write,
# and the same sequence with no holder commits), 1 otherwise: the verdict that ends the experiment.
#
# The holder is a psql session that takes a transaction id and stays idle in its transaction while the fill and the
# writer's sequence run, from its own \! (this script again, as `run.sh held`), so the horizon is held from before the
# first fill until the sequence's verdict is written, and nothing runs in the background.
set -uo pipefail
cluster=grizzle-ssi-summary
db=gz_ssi_summary
q() { "$(pg_config --bindir)/psql" -X -h "$XDG_RUNTIME_DIR/postgresql-$cluster" -d "$@"; }
# The single writer's three transactions, then its shrink; the shrink's output is the verdict's evidence.
sequence() {
	q $db -qAt -c "BEGIN ISOLATION LEVEL SERIALIZABLE" -c "INSERT INTO o VALUES (0, 5000)" -c "INSERT INTO m SELECT g, 0 FROM pg_catalog.generate_series(1, 5000) AS g" -c "COMMIT"
	q $db -q -f "$SSI_HALF" >/dev/null
	q $db -qAt -c "BEGIN ISOLATION LEVEL SERIALIZABLE" -c "SELECT n FROM o WHERE id = 0" -c "UPDATE m SET v = v + 1" -c "COMMIT" >/dev/null
	q $db -q -f "$SSI_REST" >/dev/null
	q $db -qAt -c "BEGIN ISOLATION LEVEL SERIALIZABLE" -c "UPDATE o SET n = n - 1 WHERE id = 0" -c "DELETE FROM m" -c "COMMIT" 2>&1
}
if [[ "${1:-}" == held ]]; then
	q $db -q -f "$SSI_FILL" >/dev/null
	sequence >"$SSI_HELD"
	exit 0
fi
if [[ "${1:-}" != holding ]]; then
	exec "$HOME/.local/libexec/beefy/pg-held" "$cluster" -- "$(readlink -f "$0")" holding
fi
q postgres -qc "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db"
q $db -qc "CREATE TABLE o (id int PRIMARY KEY, n int NOT NULL)" -c "CREATE TABLE m (id int PRIMARY KEY, v int NOT NULL)" -c "CREATE TABLE f (x int)"
# The pool of SERIALIZABLEXACTs: ten per backend slot and prepared transaction (predicate.c InitPredicateLocks).
pool=$(q $db -Atc "SELECT (current_setting('max_connections')::int + current_setting('autovacuum_worker_slots')::int + current_setting('max_worker_processes')::int + current_setting('max_wal_senders')::int + 1 + current_setting('max_prepared_transactions')::int) * 10")
fillers() {
	local f
	f=$(mktemp)
	for ((i = 0; i < $1; i++)); do echo "BEGIN ISOLATION LEVEL SERIALIZABLE; INSERT INTO f VALUES (1); COMMIT;"; done >"$f"
	echo "$f"
}
SSI_FILL=$(fillers $((pool + pool / 4)))
SSI_HALF=$(fillers $((pool / 2)))
SSI_REST=$(fillers $((pool / 2 + pool / 8)))
SSI_HELD=$(mktemp)
export SSI_FILL SSI_HALF SSI_REST SSI_HELD
holder=$(mktemp)
printf 'BEGIN ISOLATION LEVEL SERIALIZABLE;\nSELECT pg_catalog.pg_current_xact_id();\n\\! %q held\nROLLBACK;\n' "$(readlink -f "$0")" >"$holder"
echo "# $(date -u) cluster postgres@$cluster, pool about $pool, $(q $db -Atc 'SELECT version()')"
q $db -qAt -f "$holder" >/dev/null
held=$(cat "$SSI_HELD")
echo "## with a writing transaction held open: $held"
q $db -qc "TRUNCATE m, o"
released=$(sequence)
echo "## with no transaction held open: $released"
rm -f "$SSI_FILL" "$SSI_HALF" "$SSI_REST" "$SSI_HELD" "$holder"
q postgres -qc "DROP DATABASE $db WITH (FORCE)"
if grep -q "Canceled on identification as a pivot, with conflict out to old committed transaction" <<<"$held" && ! grep -q ERROR <<<"$released"; then
	echo "PostgreSQL fails the lone writer as README.md states"
	exit 0
fi
echo "PostgreSQL no longer fails the lone writer: the experiment's verdict is in"
exit 1
