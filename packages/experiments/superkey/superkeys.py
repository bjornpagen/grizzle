#!/usr/bin/env python3
"""SUPERKEY: the generated superkeys of a migration's tables, one per line as <table> <constraint>.

A generated superkey is a UNIQUE whose violation the migration's constraint map (meta.json, laws.constraintToLaw) reports
as another constraint's key law: the law of the table's PRIMARY KEY or of a declared or projected key, which installs
its own UNIQUE. A key law's own UNIQUE is the one constraint its law is reported for that no other key law reports.

Usage: superkeys.py <meta.json of the migration that installs the tables> [table ...]
"""
import json
import sys
from collections import defaultdict

meta = json.load(open(sys.argv[1]))["meta"]["laws"]["constraintToLaw"]["tables"]
only = set(sys.argv[2:])
for table, constraints in sorted(meta.items()):
    if only and table not in only:
        continue
    by_law = defaultdict(list)
    for name, law in constraints.items():
        if "_key_" in name or "_pk_" in name:
            by_law[law].append(name)
    for law, names in sorted(by_law.items()):
        if len(names) < 2:
            continue
        pk = [n for n in names if "_pk_" in n]
        own = pk[0] if pk else None
        for n in sorted(names):
            if n != own:
                print(table, n)
