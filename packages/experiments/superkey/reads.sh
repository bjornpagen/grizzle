#!/usr/bin/env bash
# SUPERKEY reads: each served statement that reads node (reads/*.sql, extracted from the logins' served JSON), planned
# generically (EXPLAIN (GENERIC_PLAN)) as installed and again inside one transaction that drops node's generated
# superkeys (sk.superkey) with the keys into them, then rolled back. Prints, per statement, the node indexes each plan
# scans and its estimated total cost.
# A statement that reads a staged carrier (pg_temp) plans in no fresh session and is reported unplanned.
# Usage: reads.sh <port> <reads dir>
set -euo pipefail
port=$1
dir=$2
L="$HOME/.cache/grizzle-release/SUPERKEY"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
q() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$L/cluster/socket" -p "$port" -U postgres -d qti "$@"; }
drops=$(q -c "SELECT string_agg(format('ALTER TABLE qti.node DROP CONSTRAINT %I CASCADE;', conname), E'\n') FROM sk.superkey WHERE relname = 'node'")
plan() {
	python3 -I -c '
import json, sys
plan = json.load(sys.stdin)[0]["Plan"]
used = set()
def walk(p):
    if p.get("Relation Name") == "node" and "Index Name" in p:
        used.add(p["Index Name"])
    for c in p.get("Plans", []):
        walk(c)
walk(plan)
print(round(plan["Total Cost"]), " ".join(sorted(used)) or "-")'
}
for f in "$dir"/*.sql; do
	before=$( (printf 'EXPLAIN (GENERIC_PLAN, FORMAT JSON) '; cat "$f"; printf ';\n') | q | plan) || before="unplanned"
	after=$( (printf 'BEGIN;\n%s\nEXPLAIN (GENERIC_PLAN, FORMAT JSON) ' "$drops"; cat "$f"; printf ';\nROLLBACK;\n') | q 2>/dev/null | plan) || after="unplanned"
	printf '%s\tbefore %s\tafter %s\n' "$(basename "$f")" "$before" "$after"
done
