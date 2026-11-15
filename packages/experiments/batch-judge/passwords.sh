#!/usr/bin/env bash
# batch-judge (from edullm-repin): a local password for every login role a migration created that has none in the
# secrets directory yet (RDS signs them in by IAM), and the roles as they stand.
# Usage: passwords.sh <tag> <port>
set -euo pipefail
tag=$1
port=$2
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
secrets="$W/secrets/$tag"
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
for role in $(admin -d postgres -c "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname NOT IN ('postgres', 'qti_admin')"); do
	if [ ! -s "$secrets/$role" ]; then
		openssl rand -hex 24 > "$secrets/$role"
		admin -d postgres -v pw="$(cat "$secrets/$role")" -v r="$role" <<<"ALTER ROLE :\"r\" PASSWORD :'pw';"
	fi
done
admin -d postgres -F $'\t' -c "SELECT rolname, rolreplication, rolcanlogin FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1" > "$W/out/$tag/roles.tsv"
