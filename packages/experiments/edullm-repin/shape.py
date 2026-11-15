"""The shape and production cost of one grizzle migration draft (REPIN).

Reads the draft's meta.json (every drafted statement of every file, in its place), classifies each statement by what
PostgreSQL does with it, names the table it touches and the lock PostgreSQL documents for it, and prices the work that
reads stored rows at production sizes: the row counts of the 43 packages' dry run (AXISINDEX/in/rowcounts-41-packages,
5,827,795 rows, DBSIDE's live tuples 5,827,683) and the heap bytes of DBSIDE's production snapshot where it lists the
table (its top 20), else RC1TARGET's bytes per row times those rows.

An index or constraint the draft drops is placed on its table by the source manifest (the manifest.json of the snapshot
the draft starts from), so a DROP INDEX names the table it locks and a dropped foreign key the table it references.

Usage: python3 -I shape.py <draft folder> <source manifest.json> <rowcounts dir> <DBSIDE final-snapshot.txt>
         <rc1target sizes txt> [<observed locks tsv>]
Prints the report on stdout and writes nothing.
"""
import collections, json, os, re, sys

folder, source, rcdir, dbside, rc1 = sys.argv[1:6]
observed = sys.argv[6] if len(sys.argv) > 6 else None
meta = json.load(open(os.path.join(folder, 'meta.json')))['meta']
index_table = {}
fk_references = {}
for o in json.load(open(source))['manifest']['objects']:
    for d in o['ddl']:
        if d.get('kind') == 'createIndex':
            index_table[f'{d["table"]["schema"]}.{d["name"]}'] = f'{d["table"]["schema"]}.{d["table"]["name"]}'
        for a in d.get('actions', []):
            c = a.get('constraint', {})
            if a.get('kind') == 'addConstraint' and c.get('kind') in ('unique', 'primaryKey'):
                index_table[f'{d["table"]["schema"]}.{c["name"]}'] = f'{d["table"]["schema"]}.{d["table"]["name"]}'
            if a.get('kind') == 'addConstraint' and c.get('kind') == 'foreignKey':
                fk_references[c['name']] = f'{c["references"]["schema"]}.{c["references"]["name"]}'

snake = lambda s: re.sub(r'(?<!^)(?=[A-Z])', '_', s).lower()
rows = collections.Counter()
for f in sorted(os.listdir(rcdir)):
    if f.endswith('.json'):
        for k, v in json.load(open(os.path.join(rcdir, f))).items():
            rows[snake(k)] += v

unit = {'bytes': 1, 'kB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3}
prod = {}
section = ''
for line in open(dbside):
    if line.startswith('== '):
        section = line[3:].strip()
        continue
    p = line.rstrip('\n').split('\t')
    if section.startswith('top 20') and len(p) == 8 and p[0] in ('qti', 'ledger'):
        size = lambda t: int(t.split()[0]) * unit[t.split()[1]]
        prod[p[1]] = {'total': size(p[2]), 'heap': size(p[3]), 'indexes': size(p[4]), 'reltuples': int(p[6]),
                      'pages': int(p[7])}
perrow = {}
section = ''
for line in open(rc1):
    if line.startswith('## '):
        section = line[3:].strip()
        continue
    p = line.rstrip('\n').split('\t')
    if section.startswith('rc2') and len(p) == 5 and int(p[2]) > 0:
        perrow[p[0]] = int(p[1]) / int(p[2])


def heap_bytes(table):
    """A table's heap at production: DBSIDE's pages where it lists it, else rows times RC1TARGET's bytes a row."""
    if table in prod:
        return prod[table]['pages'] * 8192, 'DBSIDE'
    if table in perrow:
        return rows[table] * perrow[table], 'rows x rc1target B/row'
    return None, 'unmeasured'


ident = r'"([^"]+)"\."([^"]+)"'
doc_lock = {
    'index.create.concurrent': 'SHARE UPDATE EXCLUSIVE (table), outside a transaction, waits out older snapshots',
    'index.create': 'SHARE (table): blocks writes',
    'index.drop.concurrent': 'SHARE UPDATE EXCLUSIVE (table), outside a transaction',
    'index.drop': 'ACCESS EXCLUSIVE (table and index)',
    'constraint.add.unique.using-index': 'ACCESS EXCLUSIVE (table), no scan: the index is built',
    'constraint.add.unique': 'ACCESS EXCLUSIVE (table) + index build',
    'constraint.add.primary-key': 'ACCESS EXCLUSIVE (table) + index build',
    'constraint.add.foreign-key.not-valid': 'SHARE ROW EXCLUSIVE (table and referenced table), no scan',
    'constraint.add.foreign-key': 'SHARE ROW EXCLUSIVE (table and referenced table) + scan',
    'constraint.add.check.not-valid': 'ACCESS EXCLUSIVE (table), no scan',
    'constraint.add.check': 'ACCESS EXCLUSIVE (table) + scan',
    'constraint.validate': 'SHARE UPDATE EXCLUSIVE (table), ROW SHARE (referenced table) + scan',
    'constraint.drop': 'ACCESS EXCLUSIVE (table; a foreign key also its referenced table, whose triggers go)',
    'column.add.generated-stored': 'ACCESS EXCLUSIVE (table) + TABLE REWRITE (and its indexes rebuilt)',
    'column.add': 'ACCESS EXCLUSIVE (table), no rewrite',
    'column.drop': 'ACCESS EXCLUSIVE (table), no rewrite (the column is marked dropped)',
    'column.alter.type': 'ACCESS EXCLUSIVE (table) + rewrite unless binary-coercible',
    'column.alter.expression': 'ACCESS EXCLUSIVE (table) + TABLE REWRITE',
    'view.create': 'ACCESS EXCLUSIVE (the view), ACCESS SHARE (tables it reads)',
    'view.drop': 'ACCESS EXCLUSIVE (the view)',
    'function.replace': 'no table lock; the function row (plan caches invalidated)',
    'function.create': 'no table lock',
    'function.drop': 'no table lock',
    'domain.create': 'no table lock',
    'domain.drop': 'the type alone (no table holds it)',
    'trigger.create': 'SHARE ROW EXCLUSIVE (table)',
    'trigger.drop': 'ACCESS EXCLUSIVE (table)',
    'statistics.create': 'SHARE UPDATE EXCLUSIVE (table)',
    'statistics.drop': 'SHARE UPDATE EXCLUSIVE (table)',
    'analyze': 'SHARE UPDATE EXCLUSIVE (table) + sample',
}


def classify(text):
    """(kind, schema.table or object, detail) of one drafted statement."""
    t = re.sub(r'^(\s*--[^\n]*\n)+', '', text).strip()
    u = ' '.join(t.split())
    m = re.match(r'CREATE (UNIQUE )?INDEX (CONCURRENTLY )?(IF NOT EXISTS )?"([^"]+)" ON ' + ident + r' USING (\w+) \((.*)\)', u)
    if m:
        k = 'index.create' + ('.concurrent' if m.group(2) else '')
        return k, f'{m.group(5)}.{m.group(6)}', ('unique ' if m.group(1) else '') + f'{m.group(7)} ({m.group(8)}) {m.group(4)}'
    m = re.match(r'DROP INDEX (CONCURRENTLY )?(IF EXISTS )?' + ident, u)
    if m:
        name = f'{m.group(3)}.{m.group(4)}'
        rerun = ' (rerun guard of the build that follows)' if m.group(2) else ''
        return 'index.drop' + ('.concurrent' if m.group(1) else ''), index_table.get(name, f'{m.group(3)}.?'), m.group(4) + rerun
    m = re.match(r'ALTER TABLE (ONLY )?' + ident + r' (.*)$', u, re.S)
    if m:
        table, rest = f'{m.group(2)}.{m.group(3)}', m.group(4)
        a = re.match(r'ADD CONSTRAINT "([^"]+)" (UNIQUE|PRIMARY KEY|FOREIGN KEY|CHECK|EXCLUDE)(.*)$', rest, re.S)
        if a:
            kind = a.group(2).lower().replace(' ', '-')
            tail = a.group(3)
            if 'USING INDEX' in tail:
                return f'constraint.add.{kind}.using-index', table, a.group(1)
            ref = re.search(r'REFERENCES ' + ident, tail)
            detail = a.group(1) + (f' -> {ref.group(1)}.{ref.group(2)}' if ref else '')
            return f'constraint.add.{kind}' + ('.not-valid' if tail.rstrip(';').endswith('NOT VALID') else ''), table, detail
        a = re.match(r'VALIDATE CONSTRAINT "([^"]+)"', rest)
        if a:
            return 'constraint.validate', table, a.group(1)
        a = re.match(r'DROP CONSTRAINT (IF EXISTS )?"([^"]+)"', rest)
        if a:
            ref = fk_references.get(a.group(2))
            return 'constraint.drop', table, a.group(2) + (f' (foreign key -> {ref})' if ref else '')
        a = re.match(r'ADD COLUMN (IF NOT EXISTS )?"([^"]+)" (.*)$', rest, re.S)
        if a:
            stored = re.search(r'GENERATED ALWAYS AS .* STORED', a.group(3))
            return 'column.add' + ('.generated-stored' if stored else ''), table, a.group(2)
        a = re.match(r'DROP COLUMN (IF EXISTS )?"([^"]+)"', rest)
        if a:
            return 'column.drop', table, a.group(2)
        a = re.match(r'ALTER COLUMN "([^"]+)" (SET DATA TYPE|TYPE|SET EXPRESSION|DROP EXPRESSION|SET NOT NULL|DROP NOT NULL|SET DEFAULT|DROP DEFAULT)', rest)
        if a:
            k = {'SET DATA TYPE': 'type', 'TYPE': 'type', 'SET EXPRESSION': 'expression'}.get(a.group(2), a.group(2).lower().replace(' ', '-'))
            return f'column.alter.{k}', table, a.group(1)
        return 'table.alter.other', table, rest[:120]
    m = re.match(r'CREATE (OR REPLACE )?FUNCTION ' + ident, u)
    if m:
        return 'function.' + ('replace' if m.group(1) else 'create'), f'{m.group(2)}.{m.group(3)}', ''
    m = re.match(r'DROP FUNCTION (IF EXISTS )?' + ident, u)
    if m:
        return 'function.drop', f'{m.group(2)}.{m.group(3)}', ''
    m = re.match(r'CREATE (OR REPLACE )?VIEW ' + ident, u)
    if m:
        return 'view.create', f'{m.group(2)}.{m.group(3)}', ''
    m = re.match(r'DROP VIEW (IF EXISTS )?' + ident, u)
    if m:
        return 'view.drop', f'{m.group(2)}.{m.group(3)}', ''
    m = re.match(r'CREATE DOMAIN ' + ident, u)
    if m:
        return 'domain.create', f'{m.group(1)}.{m.group(2)}', ''
    m = re.match(r'DROP DOMAIN (IF EXISTS )?' + ident, u)
    if m:
        return 'domain.drop', f'{m.group(2)}.{m.group(3)}', ''
    m = re.match(r'(CREATE (CONSTRAINT )?TRIGGER|DROP TRIGGER) "([^"]+)".* ON ' + ident, u)
    if m:
        return 'trigger.' + ('drop' if m.group(1).startswith('DROP') else 'create'), f'{m.group(4)}.{m.group(5)}', m.group(3)
    m = re.match(r'(CREATE|DROP) STATISTICS (IF EXISTS )?' + ident, u)
    if m:
        return 'statistics.' + m.group(1).lower(), f'{m.group(3)}.{m.group(4)}', ''
    m = re.match(r'ANALYZE ' + ident, u)
    if m:
        return 'analyze', f'{m.group(1)}.{m.group(2)}', ''
    m = re.match(r'COMMENT ON (\w+)', u)
    if m:
        return 'comment.' + m.group(1).lower(), '', ''
    m = re.match(r'(GRANT|REVOKE) (.*?) ON (TABLE|SCHEMA|DOMAIN|FUNCTION|DATABASE|SEQUENCE|ALL TABLES IN SCHEMA)', u)
    if m:
        return f'{m.group(1).lower()}.{m.group(3).lower().split()[0]}', '', ''
    if u.startswith('ALTER DEFAULT PRIVILEGES'):
        return 'default-privileges', '', ''
    if u.startswith('SELECT "pg_catalog"."pg_advisory_xact_lock"'):
        return 'advisory-lock', '', ''
    if u.startswith('DO '):
        return 'do-block', '', ''
    if u.startswith('SET CONSTRAINTS'):
        return 'set-constraints', '', ''
    return 'other', '', u[:120]


files = []
for f in meta['files']:
    stmts = [classify(s['statement']) for s in f['steps'] if s['kind'] == 'statement']
    files.append((f['name'], stmts, sum(1 for s in f['steps'] if s['kind'] != 'statement')))

print(f'Draft {os.path.basename(os.path.normpath(folder))}: source {meta["source"][:8]}… target {meta["target"][:8]}…, '
      f'declared drops {meta["declared"]["drops"]}, renames {meta["declared"]["renames"]}')
total = sum(len(s) for _, s, _ in files)
print(f'{len(files)} files, {total} statements')
for name, stmts, other in files:
    text = open(os.path.join(folder, name)).read()
    tx = 'no-transaction (each statement alone)' if text.startswith('-- grizzle: no-transaction') else 'one transaction'
    print(f'\n== {name}: {len(stmts)} statements, {tx}')
    for k, n in collections.Counter(k for k, _, _ in stmts).most_common():
        print(f'   {n:5d}  {k}')

print('\n== Statements that read or rewrite stored rows, priced at production')
heavy = []
for name, stmts, _ in files:
    for k, table, detail in stmts:
        if k in ('index.create', 'index.create.concurrent', 'constraint.validate', 'constraint.add.foreign-key',
                 'constraint.add.check', 'constraint.add.unique', 'constraint.add.primary-key',
                 'column.add.generated-stored', 'column.alter.type', 'column.alter.expression', 'analyze'):
            heavy.append((name, k, table, detail))
by = collections.defaultdict(list)
for name, k, table, detail in heavy:
    by[(name, k)].append((table, detail))
for (name, k), items in by.items():
    hb = [heap_bytes(t.split('.', 1)[1])[0] or 0 for t, _ in items]
    r = [rows[t.split('.', 1)[1]] for t, _ in items]
    print(f'{name} {k}: {len(items)} statements over {len(set(t for t, _ in items))} tables; '
          f'rows read {sum(r):,}; heap read per pass {sum(hb) / 1024 ** 2:,.0f} MiB')
    for (t, d), rr, h in sorted(zip(items, r, hb), key=lambda x: -x[2])[:12]:
        src = heap_bytes(t.split('.', 1)[1])[1]
        print(f'     {t:42s} rows {rr:>10,}  heap {h / 1024 ** 2:8.1f} MiB ({src})  {d[:110]}')
    zero = sum(1 for x in r if x == 0)
    if zero:
        print(f'     ... {zero} of them over tables production holds no row of')

print('\n== Locks each file holds until it ends (PostgreSQL documented levels, by statement kind)')
for name, stmts, _ in files:
    levels = collections.defaultdict(set)
    for k, table, _ in stmts:
        if k in doc_lock and table:
            levels[doc_lock[k].split(' (')[0].split(',')[0]].add(table)
    print(f'{name}:')
    for lvl, ts in sorted(levels.items(), key=lambda x: (-len(x[1]), x[0])):
        big = sorted(ts, key=lambda t: (-rows[t.split('.', 1)[1]], t))[:6]
        print(f'   {lvl:26s} {len(ts):4d} relations; largest: ' + ', '.join(f'{t} ({rows[t.split(".", 1)[1]]:,})' for t in big))

print('\n== Every table rewrite, index build, constraint, column, view and function change')
for name, stmts, _ in files:
    for k, table, detail in stmts:
        if k.startswith(('comment', 'grant', 'revoke', 'default-privileges', 'advisory-lock')):
            continue
        rr = rows[table.split('.', 1)[1]] if '.' in table else 0
        print(f'{name}\t{k}\t{table}\t{rr}\t{detail[:160]}')

if observed:
    print('\n== Observed locks: pg_locks of the lock probe backend at the end of each file transaction (migrate.sh)')
    print('   (catalog and TOAST relations left out; a bare number is a relation the same transaction dropped)')
    seen = collections.defaultdict(lambda: collections.defaultdict(set))
    for line in open(observed):
        p = line.rstrip('\n').split('\t')
        if len(p) >= 4 and not p[1].startswith(('pg_catalog.', 'pg_toast.')) and p[1] not in ('object', 'advisory'):
            seen[p[0]][p[2]].add(p[1])
    for f, modes in seen.items():
        print(f'{f}:')
        for mode, rels in sorted(modes.items(), key=lambda x: (-len(x[1]), x[0])):
            named = sorted((r for r in rels if not r.isdigit()), key=lambda r: (-rows[r.split('.', 1)[-1]], r))
            dropped = sum(1 for r in rels if r.isdigit())
            tables = [r for r in named if rows[r.split('.', 1)[-1]] > 0]
            print(f'   {mode:24s} {len(rels):4d} relations ({dropped} dropped by the file); holding rows at production: '
                  + (', '.join(f'{r} ({rows[r.split(".", 1)[-1]]:,})' for r in tables[:12]) + (f' and {len(tables) - 12} more' if len(tables) > 12 else '') if tables else 'none'))
