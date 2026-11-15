#!/usr/bin/env bash
# compare.sh <out> <name-a> <name-b> [file...]: two tiers' runs in <out> (pair.sh) side by side. For each, its wall
# time and failures, each failed file a deadline cut (its output reports DeadlineReached or an interrupted fiber: its
# hour ran out first) or a failure; each member's samples (summarize.sh); then the files both runs passed, the files
# named excluded, by their times; and the freeze windows, ten seconds and more with at most two backends on the CPU
# and at least half the active ones waiting on SSI's LWLocks.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out=$1
a=$2
b=$3
shift 3
excluded=$(printf '%s\n' "$@")
for run in "$a" "$b"; do
	echo "######## $run: $(cat "$out/$run.wall" 2>/dev/null || echo running)"
	awk -v X="$excluded" '
		BEGIN { nx = split(X, xs, "\n"); for (i = 1; i <= nx; i++) if (xs[i] != "") skip["test/" xs[i]] = 1 }
		match($0, /^(stdout|stderr) \| (test\/[^ ]+\.test\.ts)/, h) { block = h[2] }
		/DeadlineReached|InterruptError/ { if (block != "") cut[block] = 1 }
		match($0, /^ (.) \|[a-z-]+\| (test\/[^ ]+\.test\.ts) \(.*\) ([0-9]+)ms/, f) { files++; mark[f[2]] = f[1]; ms[f[2]] = f[3] }
		END {
			for (k in mark) if (mark[k] != "✓") { if (k in skip) x = x "  excluded " k "\n"; else if (k in cut) c = c "  deadline " k " " int(ms[k] / 1000) " s\n"; else e = e "  failed   " k " " int(ms[k] / 1000) " s\n" }
			printf "files reported %d\n%s%s%s", files, e, c, x
		}' "$out/$run.out"
	"$here/summarize.sh" "$out/$run".*.samples
done
table() {
	awk 'match($0, /^ (.) \|[a-z-]+\| (test\/[^ ]+\.test\.ts) \(.*\) ([0-9]+)ms/, f) { print f[2] "\t" f[3] "\t" f[1] }' "$out/$1.out" | sort
}
echo "######## files both runs passed, excluded files left out: seconds in $a, in $b, and $b over $a"
join -t $'\t' <(table "$a") <(table "$b") | awk -F'\t' -v X="$excluded" '
	BEGIN { nx = split(X, xs, "\n"); for (i = 1; i <= nx; i++) if (xs[i] != "") skip["test/" xs[i]] = 1 }
	$3 == "✓" && $5 == "✓" && !($1 in skip) && $2 > 0 && $4 > 0 { n++; sa += $2; sb += $4; lr += log($4 / $2); r[n] = $4 / $2; line[n] = sprintf("%-62s %8.0f %8.0f %5.2f", $1, $2 / 1000, $4 / 1000, $4 / $2) }
	END {
		asort(r, sorted)
		printf "%d files: %.0f s and %.0f s summed, ratio %.3f; per-file ratio geometric mean %.3f, median %.3f\n", n, sa / 1000, sb / 1000, sb / sa, exp(lr / n), sorted[int((n + 1) / 2)]
		for (i = 1; i <= n; i++) print line[i] | "sort -k2 -rn | head -25"
	}'
echo "######## freeze windows"
for f in "$out/$a".*.samples "$out/$b".*.samples; do
	awk -F'\t' -v F="$(basename "$f")" '$1 == "S" && NF >= 14 {
		frozen = ($14 <= 2 && $4 > 10 && $6 * 2 >= $4)
		if (frozen) { if (!run) start = $2; run++ } else { if (run >= 10) print F, start, "to", prev, run " s"; run = 0 }
		prev = $2
	} END { if (run >= 10) print F, start, "to", prev, run " s (open)" }' "$f"
done
