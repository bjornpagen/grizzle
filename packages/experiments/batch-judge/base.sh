#!/usr/bin/env bash
# batch-judge: a base database for batches, made from <template> (by default qti, which holds gather.sh's src rows and
# the install's policy rows; CREATE DATABASE ... TEMPLATE): the packages <packages file> lists written in one transaction
# with session_replication_role = replica, so no trigger runs (their rows are the staged publishes', which each kept
# every law), then, with `stats`, VACUUM ANALYZE of every table, as autovacuum would leave them; with `nostats`, none.
# Usage: base.sh <tag> <port> <name> <packages file> <stats|nostats> [<template>]
set -euo pipefail
tag=$1
port=$2
name=$3
packages=$(readlink -f "$4")
stats=$5
template=${6:-qti}
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
out="$W/out/$tag/base-$name"
mkdir -p "$out"
psqlq() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
psqlq -d postgres -c "DROP DATABASE IF EXISTS $name" -c "CREATE DATABASE $name TEMPLATE $template STRATEGY FILE_COPY"
if [ -s "$packages" ]; then
	python3 -I "$S/batchsql.py" "$P/bin/psql" "$state/socket" "$port" "$name" insert "$packages" "$out/load.sql"
	{
		echo "SET session_replication_role = replica;"
		grep -v '^-- step:' "$out/load.sql"
	} | /usr/bin/time -f "load wall %e s" psqlq -d "$name" > "$out/load.log" 2>&1
fi
case "$stats" in
stats) /usr/bin/time -f "vacuum analyze wall %e s" psqlq -d "$name" -c "VACUUM ANALYZE" >> "$out/load.log" 2>&1 ;;
nostats) ;;
*) echo "stats|nostats" >&2; exit 2 ;;
esac
psqlq -d "$name" -c "CHECKPOINT"
psqlq -d "$name" -c "SELECT count(*), pg_size_pretty(pg_database_size('$name')) FROM qti.package" | tee -a "$out/load.log"
