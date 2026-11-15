#!/usr/bin/env bash
# REPIN: every table's columns of a cluster's qti database, "<schema>.<table>\t<c1>,<c2>,...", by column name, the
# dropped ones left out, for intersect.py.
# Usage: columns.sh <tag> <port> <out file>
set -euo pipefail
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
"$P/bin/psql" -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -h "$W/clusters/$1/socket" -p "$2" -U postgres -d qti > "$3" <<'SQL'
SELECT n.nspname || '.' || c.relname, string_agg(a.attname, ',' ORDER BY a.attname COLLATE "C")
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
GROUP BY 1 ORDER BY 1
SQL
