#!/usr/bin/env bash
# batch-judge: gather.sh's rows from one cluster's template qti into another's: schema src (pg_dump, pg_restore) and
# the install's policy rows gather.sh wrote into their own tables (gather.log's `install rows:` lines), by binary COPY.
# Both installations are of the same tables, so the rows fit either.
# Usage: copysrc.sh <from tag> <from port> <to tag> <to port>
set -euo pipefail
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
from() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$W/clusters/$1/socket" -p "$2" -U postgres -d qti "${@:3}"; }
"$P/bin/pg_dump" -h "$W/clusters/$1/socket" -p "$2" -U postgres -d qti -n src -Fc -f "$W/out/$1/src.dump"
"$P/bin/pg_restore" -h "$W/clusters/$3/socket" -p "$4" -U postgres -d qti --no-owner "$W/out/$1/src.dump"
for t in $(sed -n 's/^install rows: \([^ ]*\) .*/\1/p' "$W/out/$1/gather.log"); do
	cols=$(from "$1" "$2" -c "SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = '$t'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''")
	from "$1" "$2" -c "COPY (SELECT $cols FROM $t) TO STDOUT (FORMAT binary)" | from "$3" "$4" -c "COPY $t ($cols) FROM STDIN (FORMAT binary)"
	echo "$t: $(from "$3" "$4" -c "SELECT count(*) FROM $t") rows"
done
