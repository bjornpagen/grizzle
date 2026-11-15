"""The worst-case B-tree entry of every index a grizzle migration folder drafts, from the DDL's own column types.
Each datum at its type's longest: smallint 2, integer 4, bigint 8, uuid 16, boolean 1, bit(n) VARBITTOTALLEN(n) =
8 + ceil(n/8), a text under a domain CHECK octet_length(VALUE) <= k at 4 + k; a domain at its base's. Laid out as
index_form_tuple does (heaptuple.c fill_val): the 8-byte header, 16 with the null bitmap where a column may be NULL;
exact offsets while every datum is fixed-width and NOT NULL, then each datum after its worst padding (align - 1);
the whole MAXALIGNed to 8. Usage: python3 -I indexbounds.py <folder> [limit]"""
import re, sys, os
d = sys.argv[1]; limit = int(sys.argv[2]) if len(sys.argv) > 2 else 2704
setup = open(os.path.join(d, '01-setup.sql')).read()
structure = open(os.path.join(d, '02-structure.sql')).read()
indexes = open(os.path.join(d, '03-indexes.sql')).read()
base = {'smallint': (2, 2, True), 'integer': (4, 4, True), 'bigint': (8, 8, True), 'uuid': (16, 1, True), 'boolean': (1, 1, True)}
domains = {}
for m in re.finditer(r'CREATE DOMAIN ("[a-z_0-9]+"\."[a-z0-9_]+") AS ([^\n]+)', setup):
    name, rest = m.group(1), m.group(2)
    b = re.match(r'bit\((\d+)\)', rest)
    if b:
        domains[name] = (8 + (int(b.group(1)) + 7) // 8, 4, False); continue
    t = re.match(r'"pg_catalog"\."text"', rest)
    if t:
        k = re.search(r'"pg_catalog"\."octet_length"\(VALUE\) <= (\d+)', rest)
        domains[name] = (4 + int(k.group(1)), 4, False) if k else None; continue
    for bt, v in base.items():
        if rest.startswith(bt):
            domains[name] = v
def datum(ty):
    ty = ty.strip()
    for name, v in domains.items():
        if ty.startswith(name):
            return v
    for bt, v in base.items():
        if ty.startswith(bt):
            return v
    b = re.match(r'bit\((\d+)\)', ty)
    if b:
        return (8 + (int(b.group(1)) + 7) // 8, 4, False)
    return None
cols = {}
for m in re.finditer(r'CREATE TABLE ("[a-z_0-9]+"\."[a-z_0-9]+") \((.*?)\n\);', structure, re.S):
    for line in m.group(2).split('\n'):
        cm = re.match(r'\s+"([a-z_0-9]+)" (.+)$', line)
        if cm and not line.strip().startswith('CONSTRAINT'):
            cols.setdefault(m.group(1), {})[cm.group(1)] = (cm.group(2), 'NOT NULL' in cm.group(2))
for m in re.finditer(r'ALTER TABLE ("[a-z_0-9]+"\."[a-z_0-9]+")(.*?);\n', structure, re.S):
    for am in re.finditer(r'ADD COLUMN "([a-z_0-9]+)" ([^\n]+)', m.group(2)):
        cols.setdefault(m.group(1), {})[am.group(1)] = (am.group(2), 'NOT NULL' in am.group(2))
def entry(t, columns):
    ds = []
    for c in columns:
        ty, notnull = cols[t][c]
        v = datum(ty)
        if v is None:
            return None, f'{c}: {ty[:40]} has no bound'
        ds.append((c, v, notnull))
    nullable = any(not n for _, _, n in ds)
    off, exact = (16 if nullable else 8), True
    for c, (b, a, fixed), notnull in ds:
        if exact and fixed and notnull and not nullable:
            off = (off + a - 1) // a * a + b
        else:
            exact = False
            off = off + a - 1 + b
    return (off + 7) // 8 * 8, None
rows, unbounded = [], []
def idx(kind, name, t, columns):
    e, why = entry(t, columns)
    if e is None:
        unbounded.append((kind, name, t, why)); return
    sets = [c for c in columns if re.search(r'bit\(|_bits_', cols[t][c][0])]
    rows.append((e, kind, name, t, len(columns), sets))
for m in re.finditer(r'CREATE TABLE ("[a-z_0-9]+"\."[a-z_0-9]+") \((.*?)\n\);', structure, re.S):
    for cm in re.finditer(r'CONSTRAINT "([^"]+)" (PRIMARY KEY|UNIQUE NULLS DISTINCT|UNIQUE) \(([^)]*)\)', m.group(2)):
        idx(cm.group(2), cm.group(1), m.group(1), re.findall(r'"([a-z_0-9]+)"', cm.group(3)))
for m in re.finditer(r'ALTER TABLE ("[a-z_0-9]+"\."[a-z_0-9]+")(.*?);\n', structure, re.S):
    for cm in re.finditer(r'ADD CONSTRAINT "([^"]+)" (PRIMARY KEY|UNIQUE NULLS DISTINCT|UNIQUE) \(([^)]*)\)', m.group(2)):
        idx(cm.group(2), cm.group(1), m.group(1), re.findall(r'"([a-z_0-9]+)"', cm.group(3)))
for m in re.finditer(r'CREATE (UNIQUE )?INDEX "([^"]+)" ON ("[a-z_0-9]+"\."[a-z_0-9]+") USING btree \(([^;]*)\);', indexes):
    idx('INDEX btree', m.group(2), m.group(3), re.findall(r'"([a-z_0-9]+)"', m.group(4)))
rows.sort(reverse=True)
print(f'B-tree indexes bounded: {len(rows)}; past {limit}: {sum(1 for r in rows if r[0] > limit)}; unbounded: {len(unbounded)}')
print('worst five:')
for r in rows[:5]:
    print('  ', r[0], r[1], r[2], r[3], f'{r[4]} columns', 'sets: ' + ','.join(r[5]) if r[5] else '')
print('holding a set:')
for r in rows:
    if r[5]:
        print('  ', r[0], r[1], r[2], r[3], f'{r[4]} columns', 'sets: ' + ','.join(r[5]))
for u in unbounded[:10]:
    print('unbounded:', u)
