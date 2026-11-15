#!/usr/bin/env bash
# REPIN: price.sh's script run on a clone of a cluster's qti (qti_price, TEMPLATE qti) as qti_admin, as push-db would
# run it on production: every statement timed, the locks and WAL printed, all rolled back. The clone is dropped.
# Usage: price-run.sh <tag> <port> <price.sql> <out file>
set -euo pipefail
tag=$1
port=$2
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
admin -d postgres -c "DROP DATABASE IF EXISTS qti_price" -c "CREATE DATABASE qti_price TEMPLATE qti OWNER qti_admin"
rc=0
PGPASSWORD="$(cat "$W/secrets/$tag/qti_admin")" /usr/bin/time -f "wall %e s" "$P/bin/psql" -X \
	-d "host=localhost port=$port dbname=qti_price user=qti_admin sslmode=verify-full sslrootcert=$state/tls/ca.crt" \
	-v ON_ERROR_STOP=1 -v DBNAME=qti_price -v ledger__learner=ledger__learner -v ledger__publisher=ledger__publisher \
	-f "$3" > "$4" 2>&1 || rc=$?
admin -d postgres -c "DROP DATABASE qti_price"
echo "exit $rc" >> "$4"
[ "$rc" = 0 ]
