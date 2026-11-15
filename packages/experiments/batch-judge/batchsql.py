"""batch-judge: the SQL of one batch, k packages' rows written in one transaction, as cpustep.py steps.

A step `begin`, then one INSERT ... SELECT per table from the gathered rows (gather.sh's schema src, each table's
non-generated columns under the same names) restricted to the batch's packages, each table after every table a
non-deferrable foreign key of it references, then `commit`. With `delete`, one DELETE per table of the batch's rows,
each table before every table it references. A table is keyed by its `package` column, qti.package by `name`.

Usage: python3 -I batchsql.py <psql> <socket dir> <port> <database> <insert|delete> <packages file> <out steps.sql>"""
import subprocess, sys
psql, sock, port, db, mode, packages_file, out = sys.argv[1:8]
packages = [l.split("\t")[1] for l in open(packages_file).read().splitlines() if l]

def q(sql):
    r = subprocess.run([psql, "-X", "-q", "-At", "-F", "\t", "-h", sock, "-p", port, "-U", "postgres", "-d", db, "-c", sql],
                       capture_output=True, text=True, check=True)
    return [l.split("\t") for l in r.stdout.splitlines() if l]

src = q("""SELECT c.relname, (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = 1)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'src' AND c.relkind = 'r'""")
tables = {}
for rel, _ in src:
    schema, table = rel.split("__", 1)
    oid = q(f"SELECT to_regclass('{schema}.{table}')::oid")[0][0]
    cols = [c for (c,) in q(f"""SELECT quote_ident(a.attname) FROM pg_attribute a WHERE a.attrelid = '{schema}.{table}'::regclass
AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum""")]
    keyed = "name" if (schema, table) == ("qti", "package") else "package"
    if keyed not in cols:
        continue
    tables[oid] = (schema, table, rel, cols, keyed)
deps = {oid: set() for oid in tables}
for child, parent in q("SELECT conrelid, confrelid FROM pg_constraint WHERE contype = 'f' AND NOT condeferrable"):
    if child in deps and parent in tables and parent != child:
        deps[child].add(parent)
order, done = [], set()
def visit(o, path=()):
    if o in done:
        return
    if o in path:
        raise SystemExit(f"cycle at {tables[o][2]}")
    for p in sorted(deps[o]):
        visit(p, path + (o,))
    done.add(o)
    order.append(o)
for o in sorted(tables, key=lambda o: tables[o][2]):
    visit(o)
names = ", ".join("'" + p.replace("'", "''") + "'" for p in packages)
with open(out, "w") as f:
    f.write("-- step: begin\nBEGIN ISOLATION LEVEL SERIALIZABLE;\n")
    for o in (order if mode == "insert" else list(reversed(order))):
        schema, table, rel, cols, keyed = tables[o]
        c = ", ".join(cols)
        if mode == "insert":
            f.write(f"-- step: insert {schema}.{table}\nINSERT INTO {schema}.{table} ({c}) SELECT {c} FROM src.{rel} WHERE {keyed} IN ({names});\n")
        else:
            f.write(f"-- step: delete {schema}.{table}\nDELETE FROM {schema}.{table} WHERE {keyed} IN ({names});\n")
    f.write("-- step: commit\nCOMMIT;\n")
print(len(order), "tables,", len(packages), "packages")
