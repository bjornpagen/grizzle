#!/usr/bin/env bash
# REPIN (from FAMWRITE's setup.sh, from BULKLOAD, IMPORTPAR): a fresh production-shaped cluster, set up as edullm-qti-db
# was rebuilt: RDS's roles (rds_superuser, rds_replication, rds_iam), the master user qti_admin (CREATEROLE CREATEDB,
# member of rds_superuser), the database qti as out/qti-rebuild-20261114/create-db.sh makes it (builtin C.UTF-8,
# en_US.UTF-8, serializable on the database), then `grizzle migrate importpar.config.ts` of the given edullm tree's
# committed migrations as qti_admin, with that tree's own grizzle, then a local password for each login (RDS signs them
# in by IAM). The postmaster runs in the systemd user scope repin-<tag>, CPUQuota 800% (the instance's 8 vCPU).
# Usage: setup.sh <tag> <port> <edullm tree>
set -euo pipefail
tag=$1
port=$2
tree=$(readlink -f "$3")
W="${REPIN_WORK:-$HOME/.cache/grizzle-release/REPIN}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
secrets="$W/secrets/$tag"
out="$REPIN_OUT/$tag"
mkdir -p "$W/clusters" "$out"
mkdir -p -m 700 "$W/secrets" "$secrets"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
bash "$S/overlay.sh" "$tree"
echo "tree $tree $(git -C "$tree" rev-parse --short HEAD) grizzle $(git -C "$tree/vendor/grizzle" rev-parse --short HEAD)" > "$out/setup-tree.txt"

bash "$S/init-cluster.sh" "$P" "$state" "$port" "repin-$tag" > "$out/init.log" 2>&1
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
	cd "$tree/packages/data/qti-database"
	IMPORTPAR_PORT=$port IMPORTPAR_CA="$state/tls/ca.crt" IMPORTPAR_SECRETS="$secrets" \
		/usr/bin/time -f "wall %e s, maxrss %M kB" node --disable-proto=delete --disable-sigusr1 \
		"$tree/vendor/grizzle/packages/grizzle/src/cli/main.ts" migrate importpar.config.ts
) > "$out/setup-migrate.log" 2>&1 || rc=$?
echo "exit $rc" >> "$out/setup-migrate.log"
[ "$rc" = 0 ] || { cat "$out/setup-migrate.log"; exit "$rc"; }

bash "$S/passwords.sh" "$tag" "$port"
admin -d qti -F $'\t' -c "SELECT name, setting, source FROM pg_settings WHERE source NOT IN ('default', 'override') ORDER BY 1" > "$out/settings.tsv"
cat "$out/setup-tree.txt" "$out/init.log" "$out/setup-migrate.log"
