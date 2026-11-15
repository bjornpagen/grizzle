#!/usr/bin/env python3
"""MULTICORE: which relations each publish held SIRead locks on, from out/<tag>/siread.tsv (sampled every 5 s): for a
partitioned arm, each relation is read as a partition of a package (its name ends in __<16 hex of md5(package)>,
multicore.partition_name), and a lock on another package's partition is a cross-package lock; the rest are shared
relations. Also the lock waits activity.tsv sampled (wait_event_type Lock) per publish.
Usage: python3 -I siread.py <out dir of the arm> <package name...>"""
import csv
import hashlib
import os
import re
import sys

d = sys.argv[1]
suffix = {hashlib.md5(n.encode()).hexdigest()[:16]: n for n in sys.argv[2:]}
held = {}
p = os.path.join(d, "siread.tsv")
if os.path.exists(p):
    for row in csv.reader(open(p), delimiter="\t"):
        if len(row) != 6:
            continue
        _, app, locktype, relkind, rel, n = row
        held.setdefault(app, {}).setdefault(rel, set()).add(locktype)
for app in sorted(held):
    print(app, f"relations {len(held[app])}")
    by_pkg = {}
    for rel in held[app]:
        s = re.search(r"__([0-9a-f]{16})$", rel)
        key = suffix.get(s.group(1), "?") if s else "shared"
        by_pkg.setdefault(key, []).append(rel)
    for key, rels in sorted(by_pkg.items()):
        sample = ", ".join(sorted(rels)[:6])
        print(f"  {key}: {len(rels)} relations ({sample}{', ...' if len(rels) > 6 else ''})")

waits = {}
p = os.path.join(d, "activity.tsv")
if os.path.exists(p):
    for row in csv.reader(open(p), delimiter="\t"):
        if len(row) >= 6 and row[2].startswith("multicore-") and row[4] == "Lock":
            waits.setdefault(row[2], {}).setdefault(row[5], 0)
            waits[row[2]][row[5]] += 1
for app, w in sorted(waits.items()):
    print(app, "lock-wait samples", w)
