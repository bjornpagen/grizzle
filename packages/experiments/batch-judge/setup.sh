#!/usr/bin/env bash
# batch-judge (from edullm-repin's setup.sh): a fresh production-shaped 19rc1 cluster (init-cluster.sh, CPUQuota 800%,
# the instance's 8 vCPU) set up as edullm-qti-db was rebuilt: RDS's roles, the master user qti_admin, the database qti
# (builtin C.UTF-8, en_US.UTF-8, serializable on the database), `grizzle migrate importpar.config.ts` of the tree's
# migrations as qti_admin with the tree's own grizzle, then a local password for each login. Autovacuum is off, so no
# table holds statistics but those a run takes itself.
# Usage: setup.sh <tag> <port> <edullm tree>
set -euo pipefail
tag=$1
port=$2
tree=$(readlink -f "$3")
W="${BATCH_WORK:-$HOME/.cache/grizzle-release/BULKLOAD/batch}"
S=$(dirname "$(readlink -f "$0")")
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
state="$W/clusters/$tag"
secrets="$W/secrets/$tag"
out="$W/out/$tag"
mkdir -p "$W/clusters" "$out"
mkdir -p -m 700 "$W/secrets" "$secrets"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
echo "tree $tree $(git -C "$tree" rev-parse --short HEAD) grizzle $(git -C "$tree/vendor/grizzle" rev-parse --short HEAD) $(git -C "$tree/vendor/grizzle" diff --shortstat)" > "$out/setup-tree.txt"
bash "$S/init-cluster.sh" "$P" "$state" "$port" "batch-$tag" > "$out/init.log" 2>&1
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
ALTER SYSTEM SET autovacuum = off;
SELECT pg_reload_conf();
SQL
admin -d postgres <<'SQL'
create database qti owner qti_admin template template0 encoding 'UTF8'
  locale_provider builtin builtin_locale 'C.UTF-8' lc_collate 'en_US.UTF-8' lc_ctype 'en_US.UTF-8';
alter database qti set default_transaction_isolation = serializable;
SQL
rc=0
(
	cd "$tree/packages/data/qti-database"
	IMPORTPAR_PORT=$port IMPORTPAR_CA="$state/tls/ca.crt" IMPORTPAR_SECRETS="$secrets" IMPORTPAR_DATABASE=qti \
		/usr/bin/time -f "wall %e s, maxrss %M kB" node --disable-proto=delete --disable-sigusr1 \
		"$tree/vendor/grizzle/packages/grizzle/src/cli/main.ts" migrate importpar.config.ts
) > "$out/migrate.log" 2>&1 || rc=$?
echo "exit $rc" >> "$out/migrate.log"
[ "$rc" = 0 ] || { cat "$out/migrate.log"; exit "$rc"; }
bash "$S/passwords.sh" "$tag" "$port"
cat "$out/setup-tree.txt" "$out/init.log" "$out/migrate.log"
