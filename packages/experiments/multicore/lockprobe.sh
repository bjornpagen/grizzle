#!/usr/bin/env bash
# MULTICORE: does making one package's partitions wait for another package's publish? A fresh clone <tag> of <template>
# (qti_p: multicore.provision, CREATE TABLE ... PARTITION OF; qti_q: multicore.provision_attach, LIKE + ATTACH + the
# paired keys) gets package <a>'s partitions, then <a>'s publish starts fence-free; once its backend holds a lock on a
# partition of qti.node (it has written), package <b>'s partitions are made in a session of its own, timed, while each
# 0.5 s the lock it waits on (if any) is recorded (locks.tsv). It ends with the publish.
# Usage: lockprobe.sh <tag> <template> <a idx> <b idx>
set -uo pipefail
tag=$1
template=$2
a=$3
b=$4
M="$HOME/.cache/grizzle-release/MULTICORE"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
E="$(cd "$(dirname "$0")" && pwd)"
out="$M/out/$tag"
mkdir -p "$out"
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$M/cluster/socket" -p 5741 -U postgres "$@"; }
name() { sed -n "$(($1 + 1))p" "$M/packages/CURRENT.tsv" | cut -f1; }
case $template in
qti_p) provision=provision ;;
qti_q) provision=provision_attach ;;
esac

admin -d postgres -c "DROP DATABASE IF EXISTS \"$tag\"" -c "CREATE DATABASE \"$tag\" TEMPLATE \"$template\" STRATEGY FILE_COPY" \
	-c "ALTER DATABASE \"$tag\" SET default_transaction_isolation = serializable" \
	-c "GRANT TEMPORARY ON DATABASE \"$tag\" TO ledger__publisher"
cp "$M/served/free.json" "$M/edullm/packages/data/qti-database/install/migrations/qti/served/publisher_app.json"
admin -d "$tag" -c "SELECT multicore.$provision('$(name "$a")')" > /dev/null

bash "$E/run.sh" one "$tag" "$tag" "$a" &
pub=$!
until [ "$(admin -d "$tag" -c "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid JOIN pg_class c ON c.oid = l.relation WHERE s.application_name LIKE 'multicore-$a-%' AND c.relname LIKE 'node\_\_%' AND l.mode = 'RowExclusiveLock'")" != 0 ]; do
	kill -0 $pub 2>/dev/null || break
	sleep 0.5
done
t0=$(date +%s%3N)
echo "provision of $(name "$b") starts $(date -u +%FT%T.%3NZ), publish of $(name "$a") running" > "$out/lockprobe.txt"
PGAPPNAME=multicore-provision "$P/bin/psql" -X -q -At -h "$M/cluster/socket" -p 5741 -U postgres -d "$tag" \
	-c "SELECT multicore.$provision('$(name "$b")')" > "$out/provision-b.log" 2>&1 &
prov=$!
while kill -0 $prov 2>/dev/null; do
	admin -d "$tag" -F $'\t' -c "SELECT to_char(clock_timestamp(), 'HH24:MI:SS.MS'), l.locktype, l.mode, coalesce(c.relname, l.relation::text), (SELECT string_agg(DISTINCT h.application_name, ',') FROM pg_locks hl JOIN pg_stat_activity h ON h.pid = hl.pid WHERE hl.granted AND hl.relation = l.relation AND hl.pid <> l.pid) FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid LEFT JOIN pg_class c ON c.oid = l.relation WHERE s.application_name = 'multicore-provision' AND NOT l.granted" >> "$out/locks.tsv" 2>/dev/null
	sleep 0.5
done
t1=$(date +%s%3N)
echo "provision of $(name "$b") ends $(date -u +%FT%T.%3NZ) after $((t1 - t0)) ms: $(cat "$out/provision-b.log")" >> "$out/lockprobe.txt"
wait $pub
echo "publish of $(name "$a") ends $(date -u +%FT%T.%3NZ): $(tail -n 1 "$out/attempts.tsv")" >> "$out/lockprobe.txt"
cp "$M/served/fenced.json" "$M/edullm/packages/data/qti-database/install/migrations/qti/served/publisher_app.json"
cat "$out/lockprobe.txt"
cut -f2-5 "$out/locks.tsv" | sort | uniq -c | sort -rn | head -20
