"""The heap each index build of a repin migration reads and the entries it sorts: per index of its 01-indexes.sql, its
table's corpus rows (the summed row counts of the 41 packages' dry run) and heap bytes per row (RC1TARGET's loaded rc2
cluster at edullm's committed init: pg_relation_size over count(*); the old database's size over its rows where
RC1TARGET's table is empty), and the sums. A table with neither width is listed with its rows.
Usage: python3 -I repincost.py <indexes.sql> <rowcounts dir> <old sizes txt> <rc1target sizes txt>"""
import json, os, re, sys
sql, rcdir, sizes, rc1 = sys.argv[1:5]
snake = lambda s: re.sub(r'(?<!^)(?=[A-Z])', '_', s).lower()
rows = {}
for f in sorted(os.listdir(rcdir)):
    if f.endswith('.json'):
        for k, v in json.load(open(os.path.join(rcdir, f))).items():
            rows[snake(k)] = rows.get(snake(k), 0) + v
unit = {'bytes': 1, 'kB': 1024, 'MB': 1024**2, 'GB': 1024**3}
old = {}
for line in open(sizes):
    p = line.strip().split('|')
    if len(p) == 5 and p[0] == 'qti' and int(p[2]) > 0:
        sz = p[3].split()
        old[p[1]] = int(sz[0]) * unit[sz[1]] / int(p[2])
new = {}
section = ''
for line in open(rc1):
    if line.startswith('## '):
        section = line[3:].strip()
        continue
    p = line.rstrip('\n').split('\t')
    if section.startswith('rc2') and len(p) == 5 and int(p[2]) > 0:
        new[p[0]] = int(p[1]) / int(p[2])
builds = re.findall(r'CREATE (UNIQUE )?INDEX CONCURRENTLY "([^"]+)" ON "([a-z_]+)"\."([a-z_0-9]+)" USING btree \(([^;]*)\);', open(sql).read())
print(f'corpus rows (41 packages): {sum(rows.values()):,}; index builds: {len(builds)}')
heap = 0.0; entries = 0; unsized = []
per = []
for uniq, name, schema, table, cols in builds:
    r = rows.get(table, 0)
    if table in new:
        b, src = new[table], 'rc1target'
    elif table in old:
        b, src = old[table], 'old db'
    else:
        unsized.append((table, r)); continue
    per.append((r * b, table, r, b, src, bool(uniq), cols.count('"') // 2))
    heap += r * b; entries += r
per.sort(reverse=True)
print(f'heap per pass, summed over builds: {heap/1024**3:.2f} GiB; entries sorted: {entries:,}')
for h, t, r, b, src, u, k in per[:10]:
    print(f'  {t:28s} rows {r:>9,} {b:6.0f} B/row ({src}) heap {h/1024**2:7.1f} MiB {"unique" if u else "plain "} {k} cols')
print('builds with no measured width:', len(unsized), 'rows', sum(r for _, r in unsized), sorted(unsized, key=lambda x: -x[1])[:8])
