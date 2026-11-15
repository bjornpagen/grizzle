#!/usr/bin/env bash
# summarize.sh <samples>...: each member's samples (sample.sh): its client backends on average, active, on the CPU and
# waiting on SSI's LWLocks (each lock, and the waiters' median, 90th percentile and maximum); its oldest transaction
# holding a snapshot or a transaction id; the SERIALIZABLE transactions of 30 s and more; and the waits for a safe
# snapshot (IPC:SafeSnapshot, a SERIALIZABLE READ ONLY DEFERRABLE read waiting until no SERIALIZABLE writer that began
# before its snapshot runs), on average and, by test file, the samples a wait was past ten seconds and its longest.
for f in "$@"; do
	echo "== $(basename "$f")"
	awk -F'\t' '$1 == "S" && NF >= 14 {
		n++; b += $3; a += $4; w += $6; fin += $7; h += $8; p += $9; cpu += $14
		if ($12 > ms) { ms = $12; mt = $2 }
		if ($13 > mx) { mx = $13; xt = $2 }
		s[n] = $6
	} END {
		if (n == 0) { print "no samples"; exit }
		asort(s)
		printf "samples %d  backends %.1f  active %.1f  on-cpu %.1f  ssi-waiting %.1f (%.0f%% of backends, %.0f%% of active; finishedlist %.1f xacthash %.1f predlist %.1f)  p50 %d p90 %d max %d\n", n, b / n, a / n, cpu / n, w / n, (b > 0 ? 100 * w / b : 0), (a > 0 ? 100 * w / a : 0), fin / n, h / n, p / n, s[int(n * .5) + 1], s[int(n * .9) + 1], s[n]
		printf "oldest snapshot-or-xid transaction %.0f s at %s; oldest xid holder %.0f s at %s\n", ms, mt, mx, xt
	}' "$f"
	awk -F'\t' '$1 == "R" { k = $3; if ($6 > m[k]) { m[k] = $6; q[k] = substr($8, 1, 70) }; app[k] = $4 }
		END { for (k in m) if (m[k] >= 30) printf "  serializable %d s %s %s\n", m[k], app[k], q[k] }' "$f" | sed -E 's/gz_[a-z_0-9]+/gz_X/g' | sort -k2 -rn | head -8
	awk -F'\t' '$1 == "W" { n++; c = split($3, e, " "); for (i = 1; i <= c; i++) { split(e[i], kv, "="); if (kv[1] == "IPC:SafeSnapshot") s += kv[2] } }
		END { if (n > 0) printf "safe-snapshot waiters %.2f on average\n", s / n }' "$f"
	awk -F'\t' '$1 == "D" && $9 == "IPC:SafeSnapshot" { c[$5]++; if ($8 + 0 > m[$5]) m[$5] = $8 + 0 }
		END { for (k in c) printf "  safe-snapshot wait past 10 s in %d samples, longest %d s: %s\n", c[k], m[k], k }' "$f" | sort -k6 -rn | head -6
done
