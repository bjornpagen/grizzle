#!/usr/bin/env bash
# batch-judge: the staged rows gathered into the template database qti, after stage.sh. Every table a publish
# inserted into (pg_stat_user_tables.n_tup_ins in some src_<n>) gets a copy src.<schema>__<table> of its
# non-generated columns, holding every src_<n>'s rows (binary COPY out of each, into it). A table no `package` column
# keys (qti.package aside, keyed by `name`) holds the install's rows every publish writes alike (its media policy): its
# rows are written once into the table itself, from src_00, so every base made from qti holds them. Then each src_<n>
# is dropped. The row counts by table and package land in out/<tag>/gather.tsv.
# Usage: gather.sh <tag> <port>
set -euo pipefail
tag=$1
port=$2
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
out="$W/out/$tag"
psqlq() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
mapfile -t dbs < <(psqlq -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'src\_%' ORDER BY 1")
written=$(for d in "${dbs[@]}"; do
	psqlq -d "$d" -c "SELECT schemaname || '.' || relname FROM pg_stat_user_tables WHERE n_tup_ins > 0 AND schemaname <> 'src'"
done | sort -u)
psqlq -d qti -c "CREATE SCHEMA IF NOT EXISTS src"
for t in $written; do
	schema=${t%%.*}
	table=${t#*.}
	cols=$(psqlq -d qti -c "SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = '$t'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''")
	keyed=$(psqlq -d qti -c "SELECT count(*) FROM pg_attribute WHERE attrelid = '$t'::regclass AND attname = CASE WHEN '$t' = 'qti.package' THEN 'name' ELSE 'package' END AND NOT attisdropped")
	if [ "$keyed" = 1 ]; then
		psqlq -d qti -c "CREATE TABLE src.${schema}__${table} AS SELECT $cols FROM $t WITH NO DATA"
		for d in "${dbs[@]}"; do
			psqlq -d "$d" -c "COPY (SELECT $cols FROM $t) TO STDOUT (FORMAT binary)" |
				psqlq -d qti -c "COPY src.${schema}__${table} ($cols) FROM STDIN (FORMAT binary)"
		done
	else
		psqlq -d "${dbs[0]}" -c "COPY (SELECT $cols FROM $t) TO STDOUT (FORMAT binary)" |
			psqlq -d qti -c "COPY $t ($cols) FROM STDIN (FORMAT binary)"
		echo "install rows: $t $(psqlq -d qti -c "SELECT count(*) FROM $t")"
	fi
done
psqlq -d qti -F $'\t' -c "SELECT format('SELECT %L, %s, count(*) FROM src.%I GROUP BY 2', c.relname, CASE WHEN c.relname = 'qti__package' THEN 'name' ELSE 'package' END, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'src' AND c.relkind = 'r'" |
	while read -r sql; do psqlq -d qti -F $'\t' -c "$sql"; done > "$out/gather.tsv"
echo "src tables $(cut -f1 "$out/gather.tsv" | sort -u | wc -l), rows $(awk -F'\t' '{s += $3} END {print s}' "$out/gather.tsv")"
for d in "${dbs[@]}"; do psqlq -d postgres -c "DROP DATABASE $d"; done
