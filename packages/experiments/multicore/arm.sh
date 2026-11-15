#!/usr/bin/env bash
# MULTICORE: one arm. A fresh database <tag> cloned from <template> (qti: the migrated schema as generated; qti_p,
# qti_q, qti_h, cat43: partitioned by partition.py), the publisher's served file <served> (fenced: as generated, its LOCK
# TABLE ledger.published_* IN EXCLUSIVE MODE; free: IMPORTPAR's edit, no lock; kfenced and kfree: the same two of
# KEYEDWRITE's keyed reads), a statement that runs past 900 s cancelled (57014) so a pathological plan ends the attempt,
# and for qti_p and qti_q each listed package's partitions made first in a transaction of their own, timed
# (provision.tsv): qti_p by multicore.provision (PARTITION OF), qti_q by multicore.provision_attach (LIKE, ATTACH and
# the package's paired foreign keys). MULTICORE_WHATIF, if set, is one database setting for a what-if arm (a measurement
# of what a setting would change, never a fix). Then the sampler, the listed packages <width> at once, the report.
# Usage: arm.sh <tag> <template> <served> <width> <idx...>
set -uo pipefail
tag=$1
template=$2
served=$3
width=$4
shift 4
M="$HOME/.cache/grizzle-release/MULTICORE"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
E="$(cd "$(dirname "$0")" && pwd)"
out="$M/out/$tag"
mkdir -p "$out"
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$M/cluster/socket" -p 5741 -U postgres "$@"; }

admin -d postgres -c "DROP DATABASE IF EXISTS \"$tag\"" -c "CREATE DATABASE \"$tag\" TEMPLATE \"$template\" STRATEGY FILE_COPY" \
	-c "ALTER DATABASE \"$tag\" SET default_transaction_isolation = serializable" \
	-c "ALTER DATABASE \"$tag\" SET statement_timeout = '900s'" \
	-c "GRANT TEMPORARY ON DATABASE \"$tag\" TO ledger__publisher"
cp "$M/served/$served.json" "$M/edullm/packages/data/qti-database/install/migrations/qti/served/publisher_app.json"
if [ -n "${MULTICORE_WHATIF:-}" ]; then
	admin -d postgres -c "ALTER DATABASE \"$tag\" SET $MULTICORE_WHATIF"
fi
echo "template $template served $served width $width packages $* what-if ${MULTICORE_WHATIF:-none}" > "$out/arm.txt"

case $template in
qti_p) provision=provision ;;
qti_q) provision=provision_attach ;;
*) provision= ;;
esac
if [ -n "$provision" ]; then
	for idx in "$@"; do
		name=$(sed -n "$((idx + 1))p" "$M/packages/CURRENT.tsv" | cut -f1)
		t0=$(date +%s%3N)
		made=$(admin -d "$tag" -c "SELECT multicore.$provision('$name')")
		printf '%s\t%s\t%s\t%s\n' "$idx" "$name" "$made" "$(($(date +%s%3N) - t0))" >> "$out/provision.tsv"
	done
fi

rm -f "$out/stop"
bash "$E/run.sh" sample "$tag" "$tag" &
s=$!
bash "$E/run.sh" pool "$tag" "$tag" "$width" "$@"
touch "$out/stop"
wait $s
python3 -I "$E/report.py" "$out" > "$out/report.txt" 2>&1
cp "$M/served/fenced.json" "$M/edullm/packages/data/qti-database/install/migrations/qti/served/publisher_app.json"
cat "$out/report.txt"
