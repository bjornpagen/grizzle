#!/usr/bin/env bash
# MULTICORE: one private PostgreSQL 19rc1 cluster set as edullm-qti-db (init-cluster.sh), with RDS's roles, the master user
# qti_admin, and the database qti migrated by `grizzle migrate multicore.config.ts` of the scratch edullm (production's
# 62d9c0b93, grizzle d15b3d4d) as qti_admin, then a local password for each login (RDS signs them in by IAM).
# Usage: setup.sh <port>
set -euo pipefail
port=$1
M="$HOME/.cache/grizzle-release/MULTICORE"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$M/cluster"
secrets="$M/secrets"
out="$M/out/setup"
mkdir -p "$out"
mkdir -p -m 700 "$secrets"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH

bash "$(dirname "$0")/init-cluster.sh" "$P" "$state" "$port" "multicore" > "$out/init.log" 2>&1
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

rc=0
(
	cd "$M/edullm/packages/data/qti-database"
	MULTICORE_PORT=$port MULTICORE_CA="$state/tls/ca.crt" MULTICORE_SECRETS="$secrets" MULTICORE_DATABASE=qti \
		/usr/bin/time -f "wall %e s, maxrss %M kB" pnpm -s grizzle migrate multicore.config.ts
) > "$out/migrate.log" 2>&1 || rc=$?
echo "exit $rc" >> "$out/migrate.log"

for role in $(admin -d postgres -c "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname NOT IN ('postgres', 'qti_admin')"); do
	openssl rand -hex 24 > "$secrets/$role"
	admin -d postgres -v pw="$(cat "$secrets/$role")" -v r="$role" <<<"ALTER ROLE :\"r\" PASSWORD :'pw';"
done
cat "$out/init.log" "$out/migrate.log"
