#!/usr/bin/env bash
# SUPERKEY setup: a private rc1 cluster (RC1TARGET's prefix, read-only) set up as edullm-qti-db was rebuilt, edullm's
# committed Qti migrations applied by `grizzle migrate` as qti_admin, then one package published by the publisher login.
# Adapted from BULKLOAD's probe-setup.sh and probe-run.sh. The cluster lives at <lane>/cluster, its secrets at
# <lane>/secrets, its logs at <lane>/out/setup.
# Usage: setup.sh <port> <edullm checkout> <package dir> <package name>
set -euo pipefail
port=$1
edullm=$(readlink -f "$2")
dir=$(readlink -f "$3")
name=$4
here=$(dirname "$(readlink -f "$0")")
L="$HOME/.cache/grizzle-release/SUPERKEY"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$L/cluster"
secrets="$L/secrets"
out="$L/out/setup"
mkdir -p "$out"
mkdir -p -m 700 "$secrets"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
echo "edullm $(git -C "$edullm" rev-parse --short HEAD) grizzle $(git -C "$edullm/vendor/grizzle" rev-parse --short HEAD) package $dir" > "$out/scratch.txt"
bash "$here/init-cluster.sh" "$P" "$state" "$port" "superkey-$port" > "$out/init.log" 2>&1
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
openssl rand -hex 24 > "$secrets/qti_admin"
admin -d postgres -v pw="$(cat "$secrets/qti_admin")" <<'SQL'
CREATE ROLE rds_superuser NOLOGIN;
CREATE ROLE rds_replication NOLOGIN;
CREATE ROLE rds_iam NOLOGIN;
GRANT rds_replication TO rds_superuser WITH ADMIN OPTION;
GRANT rds_iam TO rds_superuser WITH ADMIN OPTION;
CREATE ROLE qti_admin LOGIN CREATEROLE CREATEDB PASSWORD :'pw';
GRANT rds_superuser TO qti_admin;
CREATE EXTENSION pg_stat_statements;
SQL
admin -d postgres <<'SQL'
create database qti owner qti_admin template template0 encoding 'UTF8'
  locale_provider builtin builtin_locale 'C.UTF-8' lc_collate 'en_US.UTF-8' lc_ctype 'en_US.UTF-8';
alter database qti set default_transaction_isolation = serializable;
SQL
qdb="$edullm/packages/data/qti-database"
cp "$here/importpar.config.edullm" "$qdb/importpar.config.ts"
cp "$here/importpar-publish.edullm" "$edullm/packages/platform/data-infrastructure/scripts/importpar-publish.ts"
rc=0
(
	cd "$qdb"
	IMPORTPAR_PORT=$port IMPORTPAR_CA="$state/tls/ca.crt" IMPORTPAR_SECRETS="$secrets" \
		/usr/bin/time -f "wall %e s, maxrss %M kB" pnpm -s grizzle migrate importpar.config.ts
) > "$out/migrate.log" 2>&1 || rc=$?
echo "exit $rc" >> "$out/migrate.log"
test "$rc" = 0
for role in $(admin -d postgres -c "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname NOT IN ('postgres', 'qti_admin')"); do
	openssl rand -hex 24 > "$secrets/$role"
	admin -d postgres -v pw="$(cat "$secrets/$role")" -v r="$role" <<<"ALTER ROLE :\"r\" PASSWORD :'pw';"
done
(cd "$edullm/packages/platform/data-infrastructure" && IMPORTPAR_PORT=$port IMPORTPAR_CA="$state/tls/ca.crt" \
	IMPORTPAR_SECRETS="$secrets" /usr/bin/time -f "wall %e s, user %U s, sys %S s, maxrss %M kB" \
	node scripts/importpar-publish.ts "$dir" "$name") > "$out/publish.log" 2>&1
echo "exit $?" >> "$out/publish.log"
cat "$out/scratch.txt" "$out/init.log" "$out/migrate.log" "$out/publish.log"
