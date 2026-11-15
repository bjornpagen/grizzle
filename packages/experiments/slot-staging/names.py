"""slot-staging experiment: the prepared statement names of a served login's write programs, as BULKLOAD's logstats.py
reads them (<index>\t<name>\t<kind>\t<relation>\t<step>): each statement of each served write, its own form's name and
its large form's, with its step's kind, its relation where it names one, and a carrier step's create or fill.

Usage: python3 -I names.py <served login json> > names.tsv"""
import json, sys

served = json.load(open(sys.argv[1]))


def walk(node, found):
    if isinstance(node, dict):
        statements = node.get("statements")
        if isinstance(statements, dict) and isinstance(statements.get("~a"), list):
            found.append(statements["~a"])
        for value in node.values():
            walk(value, found)
    elif isinstance(node, list):
        for value in node:
            walk(value, found)


def names(node, out):
    if isinstance(node, dict):
        if isinstance(node.get("name"), str) and node["name"].startswith("grizzle_") and isinstance(node.get("sql"), str):
            out.append(node["name"])
        for value in node.values():
            names(value, out)
    elif isinstance(node, list):
        for value in node:
            names(value, out)


programs = []
walk(served, programs)
for statements in programs:
    for i, s in enumerate(statements):
        step = s.get("step", {}) if isinstance(s.get("step"), dict) else {}
        kind = step.get("kind", "-")
        relation = step.get("relation", "") if isinstance(step.get("relation"), str) else ""
        part = step.get("step", "") if kind == "carrier" else ""
        own = []
        names(s, own)
        for name in dict.fromkeys(own):
            print(f"{i}\t{name}\t{kind}{':' + part if part else ''}\t{relation}\t-")
