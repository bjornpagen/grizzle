#!/usr/bin/env bash
# SUPERKEY reads-all: every served statement of both logins (reads-all/*.sql: each statement's SQL in the served JSON,
# staged carriers' left out), planned generically once as installed and once inside one transaction that drops every
# generated superkey of qti (sk.superkey; family axis targets were left out of it by prep.sql) with the keys into
# them, rolled back. Prints each statement whose estimated cost or set of scanned indexes changed, and a count of the
# rest. A statement that plans in neither (it reads a carrier only a write stages) is counted apart.
# Usage: reads-all.sh <port> <dir>
set -uo pipefail
port=$1
dir=$2
L="$HOME/.cache/grizzle-release/SUPERKEY"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
work=$(mktemp -d)
q() { "$P/bin/psql" -X -q -At -v ON_ERROR_ROLLBACK=on -h "$L/cluster/socket" -p "$port" -U postgres -d qti "$@"; }
drops=$(q -c "SELECT string_agg(format('ALTER TABLE qti.%I DROP CONSTRAINT %I CASCADE;', s.relname, s.conname), E'\n')
FROM sk.superkey s JOIN pg_constraint c ON c.conname = s.conname JOIN pg_class r ON r.oid = c.conrelid AND r.relname = s.relname
WHERE r.relnamespace = 'qti'::regnamespace")
script() {
	for f in "$dir"/*.sql; do
		printf "SELECT '@@ %s';\n" "$(basename "$f")"
		printf 'EXPLAIN (GENERIC_PLAN, FORMAT JSON) '
		cat "$f"
		printf ';\n'
	done
}
script | q > "$work/before" 2>/dev/null
(printf 'BEGIN;\n%s\n' "$drops"; script; printf 'ROLLBACK;\n') | q > "$work/after" 2>/dev/null
python3 -I - "$work/before" "$work/after" <<'PY'
import json, sys
def plans(path):
    out, name, buf = {}, None, []
    def flush():
        if name is not None:
            text = "\n".join(buf).strip()
            if text:
                p = json.loads(text)[0]["Plan"]
                used = set()
                def walk(n):
                    if "Index Name" in n:
                        used.add(f'{n.get("Relation Name")}.{n["Index Name"]}')
                    for c in n.get("Plans", []):
                        walk(c)
                walk(p)
                out[name] = (round(p["Total Cost"]), used)
    for line in open(path):
        if line.startswith("@@ "):
            flush()
            name, buf = line[3:].strip(), []
        else:
            buf.append(line.rstrip("\n"))
    flush()
    return out
before, after = plans(sys.argv[1]), plans(sys.argv[2])
same = changed = 0
for name in sorted(set(before) | set(after)):
    b, a = before.get(name), after.get(name)
    if b is None or a is None:
        print(f"{name}\tplanned before {b is not None}, after {a is not None}")
        continue
    if b == a:
        same += 1
        continue
    changed += 1
    print(f"{name}\tcost {b[0]} -> {a[0]}\tlost {sorted(b[1] - a[1])}\tgained {sorted(a[1] - b[1])}")
print(f"unchanged {same}, changed {changed}, planned before {len(before)}, after {len(after)}")
PY
rm -rf "$work"
