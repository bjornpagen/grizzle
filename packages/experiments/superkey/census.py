#!/usr/bin/env python3
"""SUPERKEY census: census.sql's rows scaled to production. Each table's bytes are multiplied by its relation's rows
over the 43 packages (AXISINDEX's dry-run row counts, one JSON per package, by relation name) over its rows in the
measured package; a table the package leaves empty is left out of the bytes and kept in the counts. Prints the totals:
indexes, unique indexes and generated superkeys, the superkeys' share of index bytes, and the tables with the most
superkey bytes.

Usage: census.py <census.sql output> <rowcounts dir> <measured package's rowcounts JSON>
"""
import glob
import json
import re
import sys

census, rowdir, measured = sys.argv[1:4]
snake = lambda name: re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()
prod = {}
for f in glob.glob(f"{rowdir}/*.json"):
    for k, v in json.load(open(f)).items():
        prod[snake(k)] = prod.get(snake(k), 0) + v
here = {snake(k): v for k, v in json.load(open(measured)).items()}
cols = ["relname", "indexes", "uniques", "superkeys", "heap", "index_bytes", "superkey_bytes", "fks_in", "fks_into_superkeys", "rows"]
rows = [dict(zip(cols, line.rstrip("\n").split("\t"))) for line in open(census) if line.strip()]
tot = dict(indexes=0, uniques=0, superkeys=0, fks_in=0, fks_into_superkeys=0, index_bytes=0.0, superkey_bytes=0.0, heap=0.0)
per = []
for r in rows:
    for k in ["indexes", "uniques", "superkeys", "fks_in", "fks_into_superkeys"]:
        tot[k] += int(r[k])
    n = here.get(r["relname"], 0)
    if n == 0:
        continue
    scale = prod.get(r["relname"], 0) / n
    ib, sb, hb = int(r["index_bytes"]) * scale, int(r["superkey_bytes"]) * scale, int(r["heap"]) * scale
    tot["index_bytes"] += ib
    tot["superkey_bytes"] += sb
    tot["heap"] += hb
    per.append((sb, r["relname"], int(r["superkeys"]), int(r["uniques"]), int(r["indexes"]), ib, prod.get(r["relname"], 0)))
mb = lambda b: f"{b / 2**20:,.0f} MB"
print(f"tables {len(rows)}; indexes {tot['indexes']}, unique {tot['uniques']}, generated superkeys {tot['superkeys']}")
print(f"foreign keys into a qti table {tot['fks_in']}, into a superkey {tot['fks_into_superkeys']}")
print(f"at production rows: heap {mb(tot['heap'])}, indexes {mb(tot['index_bytes'])}, superkeys {mb(tot['superkey_bytes'])} ({100 * tot['superkey_bytes'] / tot['index_bytes']:.1f}% of index bytes)")
print("relation\tsuperkeys/uniques/indexes\tsuperkey bytes\tindex bytes\tproduction rows")
for sb, name, s, u, i, ib, n in sorted(per, reverse=True)[:15]:
    print(f"{name}\t{s}/{u}/{i}\t{mb(sb)}\t{mb(ib)}\t{n:,}")
