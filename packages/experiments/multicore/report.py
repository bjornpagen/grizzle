#!/usr/bin/env python3
"""MULTICORE: one arm's summary from out/<tag>: per attempt (attempts.tsv) its wall, exit, SQLSTATE and publishMs; per
publisher backend its CPU (the last /proc sample of utime+stime, cpu.tsv, at most a second short); the arm's wall from
the first start to the last end, the cluster scope's CPU over it (scope.log, cgroup usage_usec) and so the cores the
cluster used on average. Usage: python3 -I report.py <out dir of the arm>"""
import csv
import os
import re
import sys

d = sys.argv[1]
rows = [r for r in csv.reader(open(os.path.join(d, "attempts.tsv")), delimiter="\t") if len(r) == 9]
hz = int(open(os.path.join(d, "clk_tck")).read().strip()) if os.path.exists(os.path.join(d, "clk_tck")) else 100

cpu = {}
apps = {}
p = os.path.join(d, "cpu.tsv")
if os.path.exists(p):
    for row in csv.reader(open(p), delimiter="\t"):
        if len(row) != 5:
            continue
        _, pid, app, ut, st = row
        cpu[pid] = (int(ut) + int(st)) / hz
        apps.setdefault(app, set()).add(pid)

t0 = min(int(r[3]) for r in rows)
t1 = max(int(r[4]) for r in rows)
print("idx\tname\tattempt\tstart+s\twall_s\texit\tsqlstate\tpublish_s\tbackend_cpu_s")
for idx, name, n, a, b, wall, rc, code, pms in rows:
    app = f"multicore-{idx}-{n}"
    c = sum(cpu[pid] for pid in apps.get(app, ()))
    pub = f"{int(pms) / 1000:.1f}" if pms != "-" else "-"
    print(f"{idx}\t{name}\t{n}\t{(int(a) - t0) / 1000:.1f}\t{wall}\t{rc}\t{code}\t{pub}\t{c:.1f}")

usage = []
p = os.path.join(d, "scope.log")
if os.path.exists(p):
    for line in open(p):
        m = re.search(r"usage_usec (\d+)", line)
        if m:
            usage.append(int(m.group(1)))
wall = (t1 - t0) / 1000
ok = sum(1 for r in rows if r[6] == "0")
serr = sum(1 for r in rows if r[7] == "40001")
dead = sum(1 for r in rows if r[7] == "40P01")
backend = sum(cpu.values())
print(f"\nattempts {len(rows)}, published {ok}, 40001 {serr}, 40P01 {dead}, arm wall {wall:.1f} s")
print(f"publisher backends' CPU {backend:.1f} s, {backend / wall:.2f} cores over the arm")
if len(usage) >= 2:
    scope = (usage[-1] - usage[0]) / 1e6
    print(f"cluster scope CPU {scope:.1f} s over the sampled span, {scope / wall:.2f} cores")
