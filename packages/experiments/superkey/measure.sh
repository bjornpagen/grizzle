#!/usr/bin/env bash
# SUPERKEY measure: <reps> rounds over the two variants prep.sql and refs.sql built, alternating which goes first, each
# step its own backend, its CPU read from the backend's /proc/self/schedstat (time on CPU, ns) before and after, so it
# counts the statements' work and the COMMIT's deferred checks and nothing of the client's:
#  node-insert: the package's rows inserted into node_<v> under a fresh package name, one autocommit INSERT;
#  refs-insert: every referencing table's rows of the package inserted into <table>_<v> in one transaction, the
#               foreign keys' checks and the rules' triggers run at its COMMIT;
#  delete:      those rows and the package's node rows deleted in one transaction, referencing tables first; then
#               the package's node rows inserted again, untimed, for the next round.
# Each result is a row of sk.result, its variant named <v><tag>. Usage: measure.sh <port> <reps> <package> [tag]
set -euo pipefail
port=$1
reps=$2
pkg=$3
tag=${4:-}
L="$HOME/.cache/grizzle-release/SUPERKEY"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
q() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$L/cluster/socket" -p "$port" -U postgres -d qti "$@"; }
cols=$(q -c "SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'qti.node'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''")
renamed=$(q -c "SELECT string_agg(CASE WHEN attname = 'package' THEN ':''name''' ELSE quote_ident(attname) END, ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'qti.node'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''")
inserts=$(q -c "SELECT string_agg(format('INSERT INTO sk.%I (%s) SELECT %s FROM qti.%I WHERE package = %L;', s.source || '_@v@', c.cols, c.cols, s.source, '$pkg'), E'\n')
FROM (SELECT DISTINCT source FROM sk.fk) s
CROSS JOIN LATERAL (SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS cols FROM pg_attribute
	WHERE attrelid = ('qti.' || quote_ident(s.source))::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '') c")
deletes=$(q -c "SELECT string_agg(format('DELETE FROM sk.%I WHERE package = %L;', source || '_@v@', '$pkg'), E'\n') FROM (SELECT DISTINCT source FROM sk.fk) s")
timed() {
	local measure=$1 v=$2 rep=$3 body=$4
	q -v v="$v" -v name="${pkg:0:${#pkg}-6}${tag:-_}r$(printf %02d "$rep")$v" <<SQL
SELECT split_part(pg_read_file('/proc/self/schedstat'), ' ', 1)::bigint AS c0, extract(epoch FROM clock_timestamp()) AS w0 \gset
$body
SELECT split_part(pg_read_file('/proc/self/schedstat'), ' ', 1)::bigint AS c1, extract(epoch FROM clock_timestamp()) AS w1 \gset
INSERT INTO sk.result (measure, variant, rep, cpu_s, wall_s, rows)
VALUES ('$measure', :'v' || '$tag', $rep, (:c1 - :c0) / 1e9, :w1 - :w0, (SELECT count(*) FROM sk.node_:v));
SQL
}
for rep in $(seq 1 "$reps"); do
	if [ $((rep % 2)) = 1 ]; then order="v0 v1"; else order="v1 v0"; fi
	for v in $order; do
		timed node-insert "$v" "$rep" "INSERT INTO sk.node_:v ($cols) SELECT $renamed FROM sk.src_node;"
		timed refs-insert "$v" "$rep" "BEGIN;
${inserts//@v@/$v}
COMMIT;"
		timed delete "$v" "$rep" "BEGIN;
${deletes//@v@/$v}
DELETE FROM sk.node_:v WHERE package = '$pkg';
COMMIT;"
		q -v v="$v" -c "INSERT INTO sk.node_$v ($cols) SELECT $cols FROM sk.src_node"
	done
	q -c "SELECT measure, variant, rep, round(cpu_s, 3), round(wall_s, 3) FROM sk.result WHERE rep = $rep AND variant LIKE '%$tag' ORDER BY at"
done
q -c "SELECT measure, variant, count(*), round(avg(cpu_s), 3) AS cpu_mean, round(min(cpu_s), 3) AS cpu_min, round(max(cpu_s), 3) AS cpu_max, round(avg(wall_s), 3) AS wall_mean FROM sk.result GROUP BY 1, 2 ORDER BY 1, 2"
