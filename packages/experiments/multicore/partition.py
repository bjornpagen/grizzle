#!/usr/bin/env python3
"""MULTICORE: rewrites a plain `pg_dump --schema-only` of a migrated database so that every listed table is partitioned
BY LIST on its package column, the representation under test: each package's heap and indexes become relations of
their own. A partitioned table's unique key must hold the partition column itself, so:

- CREATE TABLE of a listed table gains PARTITION BY LIST (<its column>): `package`, or `name` for qti.package; with
  `hash`, PARTITION BY HASH (<its column>), a fixed number of slots made once (provision.sql multicore.slots).
- ALTER TABLE ONLY of a listed table loses ONLY, so what is added to the parent reaches every partition.
- A UNIQUE constraint of a listed table whose columns lack `package` (a selector key over generated columns, which
  equal `package` where the key applies and are NULL elsewhere) gains `package` in front: no two rows that conflicted
  stop conflicting, since a non-NULL selector equals its row's package, and NULLs stay distinct.
- A FOREIGN KEY whose referenced columns are such a key gains `package` in front on both sides: the referencing row's
  own package, which equals its selector wherever the selector is not NULL (MATCH SIMPLE skips the rest).
- With `pairs`, a FOREIGN KEY between two listed tables is not created on the parents: it is written to <side out>
  and provision.sql states it once per package, from that package's partition to the same package's partition of
  the referenced table. Every foreign key of the schema pairs its package columns, so a package's rows can only
  reference the same package's rows, and the pair states the same law. A partition then attaches with no lock on
  any other package's partition (no foreign key clone takes ShareRowExclusiveLock on a parent or its partitions).
- REPLICA IDENTITY of a listed table is written to <side out> as well: a partition does not inherit it.
- CREATE PUBLICATION gains publish_via_partition_root = true, so the live decoder reads the parent's name.

Usage: python3 -I partition.py <dump.sql> <tables file, "schema.table column" a line> <out.sql> <side out.json> <list|pairs|hash>
"""
import json
import re
import sys

dump, tables_file, out_file, side_file = sys.argv[1:5]
mode = sys.argv[5]
pairs = mode == "pairs"
method = "HASH" if mode == "hash" else "LIST"
listed = dict(line.split() for line in open(tables_file) if line.strip())
text = open(dump).read()
counts = {"partitioned": 0, "only": 0, "unique": 0, "foreign": 0, "paired": 0}
identity = {}
paired = []


def bare(qualified):
    return qualified.replace('"', "")


def cols(listing):
    return [c.strip() for c in listing.split(",")]


def rewrite_create(m):
    table = bare(m.group(1))
    if table not in listed:
        return m.group(0)
    counts["partitioned"] += 1
    return f"CREATE TABLE {m.group(1)} ({m.group(2)}\n)\nPARTITION BY {method} ({listed[table]});\n"


text = re.sub(r"CREATE TABLE (\S+) \((.*?)\n\);\n", rewrite_create, text, flags=re.S)

keyless = set()


def rewrite_unique(m):
    table, name, nulls, listing = bare(m.group(2)), m.group(3), m.group(4) or "", m.group(5)
    if table not in listed or listed[table] in cols(listing):
        return m.group(0)
    keyless.add((table, tuple(cols(listing))))
    counts["unique"] += 1
    return f"{m.group(1)}ADD CONSTRAINT {name} UNIQUE{nulls} ({listed[table]}, {listing});\n"


text = re.sub(r"(ALTER TABLE (?:ONLY )?(\S+)\n    )ADD CONSTRAINT (\S+) UNIQUE( NULLS NOT DISTINCT)? \(([^)]*)\);\n",
              rewrite_unique, text)


def rewrite_foreign(m):
    table, name, mine, referenced, listing, tail = bare(m.group(2)), m.group(3), m.group(4), bare(m.group(5)), m.group(6), m.group(7)
    if (referenced, tuple(cols(listing))) in keyless:
        counts["foreign"] += 1
        mine, listing = f"package, {mine}", f"{listed[referenced]}, {listing}"
    if pairs and table in listed and referenced in listed:
        counts["paired"] += 1
        paired.append({"table": table, "name": name, "columns": mine, "referenced": referenced,
                       "referencedColumns": listing, "tail": tail})
        return ""
    return f"{m.group(1)}ADD CONSTRAINT {name} FOREIGN KEY ({mine}) REFERENCES {m.group(5)}({listing}){tail};\n"


text = re.sub(r"(ALTER TABLE (?:ONLY )?(\S+)\n    )ADD CONSTRAINT (\S+) FOREIGN KEY \(([^)]*)\) REFERENCES (\S+?)\(([^)]*)\)(.*?);\n",
              rewrite_foreign, text)
unparented = {(p["name"], p["table"]) for p in paired}
text = re.sub(r"COMMENT ON CONSTRAINT (\S+) ON (\S+) IS '(?:[^']|'')*';\n",
              lambda m: "" if (m.group(1), bare(m.group(2))) in unparented else m.group(0), text)


def strip_only(m):
    if bare(m.group(1)) not in listed:
        return m.group(0)
    counts["only"] += 1
    return f"ALTER TABLE {m.group(1)}"


text = re.sub(r"ALTER TABLE ONLY (\S+)", strip_only, text)


def keep_identity(m):
    if bare(m.group(1)) in listed:
        identity[bare(m.group(1))] = m.group(2)
    return m.group(0)


text = re.sub(r"ALTER TABLE (\S+) REPLICA IDENTITY (\w+);\n", keep_identity, text)
text = re.sub(r"(CREATE PUBLICATION \S+ WITH \()(.*?)(\);)",
              lambda m: f"{m.group(1)}{m.group(2)}, publish_via_partition_root = true{m.group(3)}", text)

open(out_file, "w").write(text)
json.dump({"identity": identity, "counts": counts, "pairs": paired}, open(side_file, "w"), indent=1, sort_keys=True)
print(json.dumps(counts), f"replica identity kept {len(identity)}")
