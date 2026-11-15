#!/usr/bin/env bash
# MULTICORE: the measurement runs on the cluster setup.sh made. Each publish is edullm's publishPackage through the
# scratch's multicore-publish.ts (S3 left out), one SERIALIZABLE transaction as the publisher login, its own node process.
#   run.sh one    <tag> <db> <idx>              publish package <idx> of CURRENT.tsv into <db>; while it fails 40001 or
#                                               40P01 run it again (each attempt recorded), any other failure ends it
#   run.sh pool   <tag> <db> <width> <idx...>   the listed packages, <width> at once (xargs -P)
#   run.sh sample <tag> <db>                    until out/<tag>/stop: each second the publisher backends' CPU from
#                                               /proc (cpu.tsv), pg_stat_activity (activity.tsv), SIRead locks by
#                                               relation every 5 s (siread.tsv), the cluster scope's cpu.stat (scope.log)
# Per attempt: out/<tag>/pkg-<idx>-<attempt>.log and a line of out/<tag>/attempts.tsv:
#   idx name attempt startEpochMs endEpochMs wallS exit sqlstate publishMs
set -uo pipefail
cmd=$1
tag=$2
db=$3
port=5741
M="$HOME/.cache/grizzle-release/MULTICORE"
P="$HOME/.cache/grizzle-release/RC1TARGET/prefix"
PK="$M/packages"
state="$M/cluster"
out="$M/out/$tag"
mkdir -p "$out"
export PATH=/opt/node/current/bin:/usr/local/bin:$PATH
driver="$M/edullm/packages/platform/data-infrastructure"
admin() { "$P/bin/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$state/socket" -p "$port" -U postgres "$@"; }
pkg() { sed -n "$(($1 + 1))p" "$PK/CURRENT.tsv"; }

attempt() {
	local idx=$1 n=$2 name id files log t0 t1 rc code pms
	IFS=$'\t' read -r name id files <<<"$(pkg "$idx")"
	log="$out/pkg-$idx-$n.log"
	t0=$(date +%s%3N)
	(cd "$driver" && PGAPPNAME="multicore-$idx-$n" MULTICORE_PORT=$port MULTICORE_CA="$state/tls/ca.crt" \
		MULTICORE_SECRETS="$M/secrets" MULTICORE_DATABASE="$db" \
		/usr/bin/time -f "wall %e s, user %U s, sys %S s, maxrss %M kB" \
		node scripts/multicore-publish.ts "$PK/$name/$id" "$name") > "$log" 2>&1
	rc=$?
	t1=$(date +%s%3N)
	code=$(grep -oE '\b(40001|40P01|57014|53[0-9A-Z]{3}|23[0-9A-Z]{3}|XX000|55P03|42[0-9A-Z]{3})\b' "$log" | head -n 1)
	grep -q 'found no serial order' "$log" && code=40001
	grep -qi 'deadlock' "$log" && code=40P01
	pms=$(grep -oE '"publishMs":[0-9]+' "$log" | cut -d: -f2)
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$idx" "$name" "$n" "$t0" "$t1" \
		"$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", (b-a)/1000}')" "$rc" "${code:--}" "${pms:--}" >> "$out/attempts.tsv"
	return $rc
}

one() {
	local n=1 code
	until attempt "$1" "$n"; do
		code=$(tail -n 1 "$out/attempts.tsv" | cut -f8)
		if [ "$code" != 40001 ] && [ "$code" != 40P01 ]; then
			return 1
		fi
		[ "$n" -ge 10 ] && return 1
		n=$((n + 1))
	done
}

case $cmd in
one)
	one "$4"
	;;
pool)
	width=$4
	shift 4
	date -u +"start %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" > "$out/when.txt"
	printf '%s\n' "$@" | xargs -P "$width" -I{} bash "$0" one "$tag" "$db" {}
	date -u +"end %FT%T.%3NZ load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/when.txt"
	;;
sample)
	cg=$(find /sys/fs/cgroup/user.slice -maxdepth 6 -type d -name "multicore.scope" | head -n 1)
	hz=$(getconf CLK_TCK)
	i=0
	while [ ! -e "$out/stop" ]; do
		now=$(date -u +%FT%T.%3N)
		admin -d postgres -F $'\t' -c "SELECT pid, application_name FROM pg_stat_activity WHERE datname = '$db' AND usename LIKE 'ledger__publisher%'" 2>/dev/null |
			while IFS=$'\t' read -r pid app; do
				[ -r "/proc/$pid/stat" ] || continue
				read -r -a f < <(sed 's/^.*) //' "/proc/$pid/stat")
				printf '%s\t%s\t%s\t%s\t%s\n' "$now" "$pid" "$app" "${f[11]}" "${f[12]}" >> "$out/cpu.tsv"
			done
		admin -d postgres -F $'\t' -c "SELECT to_char(clock_timestamp(), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), pid, application_name, state, coalesce(wait_event_type, '-'), coalesce(wait_event, '-'), coalesce(backend_xid::text, '-'), to_char(xact_start, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), to_char(query_start, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), left(regexp_replace(query, '\s+', ' ', 'g'), 60) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid()" >> "$out/activity.tsv" 2>/dev/null
		if [ $((i % 5)) = 0 ]; then
			admin -d "$db" -F $'\t' -c "SELECT to_char(clock_timestamp(), 'YYYY-MM-DD\"T\"HH24:MI:SS'), a.application_name, l.locktype, coalesce(c.relkind::text, '?'), coalesce(n.nspname || '.' || c.relname, l.relation::text), count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid LEFT JOIN pg_class c ON c.oid = l.relation LEFT JOIN pg_namespace n ON n.oid = c.relnamespace WHERE l.mode = 'SIReadLock' AND a.application_name LIKE 'multicore-%' GROUP BY 1, 2, 3, 4, 5 ORDER BY 2, 3, 5" >> "$out/siread.tsv" 2>/dev/null
			echo "$(date -u +%FT%T.%3NZ) $(tr '\n' ' ' < "$cg/cpu.stat") load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/scope.log"
		fi
		echo "$hz" > "$out/clk_tck"
		i=$((i + 1))
		sleep 1
	done
	echo "$(date -u +%FT%T.%3NZ) $(tr '\n' ' ' < "$cg/cpu.stat") load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/scope.log"
	;;
esac
