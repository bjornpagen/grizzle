#!/usr/bin/env bash
# batch-judge: the corpus's rows, each package published once through edullm's publishPackage (the per-row tree's
# importpar-publish.ts, one SERIALIZABLE transaction as publisher_app) into a database of its own, src_<n>, made from
# the migrated, empty qti (CREATE DATABASE ... TEMPLATE qti), <lanes> publishes at a time. Every statement is logged
# with its backend CPU (log_statement_stats), so each publish's CPU before COMMIT and COMMIT's own read off the log
# (sessioncpu.py, by the publisher's pid) give per-row's single-package cost into an empty database as a by-product.
# <lanes> is the run's own choice: publishes at once, each a client process and one session.
# Usage: stage.sh <tag> <port> <edullm tree> <lanes>
set -uo pipefail
tag=$1
port=$2
tree=$(readlink -f "$3")
lanes=$4
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
PK=${BATCH_PACKAGES:-/Users/bjorn/Documents/edullm/out/qti-rebuild-20261114/packages}
state="$W/clusters/$tag"
out="$W/out/$tag/stage"
mkdir -p "$out"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
tail -n +2 "$PK/CURRENT.tsv" | awk -F'\t' '{printf "%02d\t%s\t%s\n", NR - 1, $1, $2}' > "$out/packages.tsv"
admin -d postgres <<SQL
ALTER SYSTEM SET log_min_duration_statement = 0;
ALTER SYSTEM SET log_statement_stats = on;
SELECT pg_reload_conf();
SQL
while IFS=$'\t' read -r n name id; do
	admin -d postgres -c "DROP DATABASE IF EXISTS src_$n" -c "CREATE DATABASE src_$n TEMPLATE qti STRATEGY FILE_COPY"
done < "$out/packages.tsv"
publish() {
	local n=$1 name=$2 id=$3
	(cd "$tree/packages/platform/data-infrastructure" && PGAPPNAME="batch-$n" IMPORTPAR_PORT=$port \
		IMPORTPAR_CA="$state/tls/ca.crt" IMPORTPAR_SECRETS="$W/secrets/$tag" IMPORTPAR_DATABASE="src_$n" \
		/usr/bin/time -f "wall %e s, user %U s, sys %S s, maxrss %M kB" \
		node scripts/importpar-publish.ts "$PK/$name/$id" "$name") > "$out/publish-$n.log" 2>&1
	echo "exit $?" >> "$out/publish-$n.log"
	echo "$(date -u +%FT%TZ) $n $name $(tail -n 3 "$out/publish-$n.log" | tr '\n' ' ')"
}
export -f publish
export tree port state W tag out PK
date -u +"start %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" > "$out/when.txt"
xargs -a "$out/packages.tsv" -d '\n' -P "$lanes" -I{} bash -c 'IFS=$'"'"'\t'"'"' read -r n name id <<< "{}"; publish "$n" "$name" "$id"' | tee "$out/publishes.txt"
date -u +"end %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/when.txt"
admin -d postgres <<SQL
ALTER SYSTEM RESET log_min_duration_statement;
ALTER SYSTEM RESET log_statement_stats;
SELECT pg_reload_conf();
SQL
grep -L '"outcome":"accepted"' "$out"/publish-*.log | sed 's/^/not accepted: /'
