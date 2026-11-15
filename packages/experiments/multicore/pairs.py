#!/usr/bin/env python3
"""MULTICORE: the INSERTs that load partition.py's paired foreign keys (<side out.json>, "pairs") into multicore.pair.
Usage: python3 -I pairs.py <side out.json>"""
import json
import sys


def lit(s):
    return "'" + s.replace("'", "''") + "'"


for p in json.load(open(sys.argv[1]))["pairs"]:
    print(f"INSERT INTO multicore.pair VALUES ({lit(p['table'])}::regclass, {lit(p['name'])}, {lit(p['columns'])}, "
          f"{lit(p['referenced'])}::regclass, {lit(p['referencedColumns'])}, {lit(p['tail'])});")
