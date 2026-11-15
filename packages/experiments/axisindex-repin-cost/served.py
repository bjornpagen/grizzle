"""The structural property (test/support/laws/referencing.ts) over a migration folder's DDL: every FOREIGN KEY is served
by an index of its relation led by exactly its referencing columns that pair with a unique B-tree of its target within
the referenced columns (every referencing column, for the referenced columns themselves), or by a unique index within
its referencing columns. Prints the unserved ones. Usage: python3 -I served.py <folder with 02-structure.sql 03-indexes.sql>"""
import re, sys, os
d = sys.argv[1]
structure = open(os.path.join(d, '02-structure.sql')).read()
indexes = open(os.path.join(d, '03-indexes.sql')).read()
idx = {}   # table -> list of (method, cols, unique)
fks = []
def cols(text):
    return re.findall(r'"([a-z_0-9]+)"', text)
def add(t, method, c, unique):
    idx.setdefault(t, []).append((method, c, unique))
for m in re.finditer(r'CREATE TABLE ("[a-z_0-9]+"\."[a-z_0-9]+") \((.*?)\n\);', structure, re.S):
    for cm in re.finditer(r'CONSTRAINT "[^"]+" (PRIMARY KEY|UNIQUE NULLS DISTINCT|UNIQUE) \(([^)]*)\)', m.group(2)):
        temporal = 'WITHOUT OVERLAPS' in cm.group(2)
        add(m.group(1), 'gist' if temporal else 'btree', cols(cm.group(2)), not temporal)
    for cm in re.finditer(r'CONSTRAINT "[^"]+" EXCLUDE USING gist \(([^)]*)\)', m.group(2)):
        add(m.group(1), 'gist', cols(cm.group(1)), False)
for m in re.finditer(r'ALTER TABLE ("[a-z_0-9]+"\."[a-z_0-9]+")(.*?);\n', structure, re.S):
    t = m.group(1)
    for cm in re.finditer(r'ADD CONSTRAINT "([^"]+)" (PRIMARY KEY|UNIQUE NULLS DISTINCT|UNIQUE) \(([^)]*)\)', m.group(2)):
        temporal = 'WITHOUT OVERLAPS' in cm.group(3)
        add(t, 'gist' if temporal else 'btree', cols(cm.group(3)), not temporal)
    for cm in re.finditer(r'ADD CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]*)\) REFERENCES ("[a-z_0-9]+"\."[a-z_0-9]+") \(([^)]*)\)', m.group(2)):
        fks.append((cm.group(1), t, cols(cm.group(2)), cm.group(3), cols(cm.group(4))))
const = set()
for m in re.finditer(r'ALTER TABLE ("[a-z_0-9]+"\."[a-z_0-9]+")(.*?);\n', structure, re.S):
    for am in re.finditer(r'ADD COLUMN "([a-z_0-9]+)" [^\n]*GENERATED ALWAYS AS \(([^()]*?)\) STORED', m.group(2)):
        if re.fullmatch(r"(-?\d+|'[^']*'|true|false)(::[a-z_\".]+)?", am.group(2).strip()):
            const.add((m.group(1), am.group(1)))
for m in re.finditer(r'CREATE (UNIQUE )?INDEX "([^"]+)" ON ("[a-z_0-9]+"\."[a-z_0-9]+") USING (\w+) \(([^;]*)\);', indexes):
    add(m.group(3), m.group(4), cols(m.group(5)), bool(m.group(1)))
def led(i, run):
    method, c, _ = i
    return method != 'hnsw' and len(c) >= len(run) and set(c[:len(run)]) == set(run)
unserved = []
for name, t, c0, target, ref0 in fks:
    pairs = [(col, r) for col, r in zip(c0, ref0) if (t, col) not in const]
    c = [col for col, _ in pairs]; ref = [r for _, r in pairs]
    runs = [c] + [[col for col, r in zip(c, ref) if r in k[1]] for k in idx.get(target, []) if k[2] and k[0] == 'btree' and set(k[1]) <= set(ref)]
    ok = any(any(led(i, run) for run in runs) or (i[2] and i[0] == 'btree' and set(i[1]) <= set(c)) for i in idx.get(t, []))
    if not ok:
        unserved.append((name, t, c))
print(f'foreign keys: {len(fks)}; constant law columns: {len(const)}; unserved: {len(unserved)}')
for u in unserved:
    print('  ', u[0], u[1], '(' + ', '.join(u[2]) + ')')
