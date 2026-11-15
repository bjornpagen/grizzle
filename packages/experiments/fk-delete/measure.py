"""fk-delete: one package's whole delete in one SERIALIZABLE transaction, its deferred checks fired by SET CONSTRAINTS
ALL IMMEDIATE, then ROLLBACK, so the stored package stays and the next run deletes the same rows. The deletes are one
DELETE per table keyed by `package` (qti.package by `name`), each table before every table a non-deferrable foreign
key of it references, as BULKLOAD's batchsql.py ordered them; the deferred foreign keys' order is free. Before the
deletes, the transaction runs <variant sql> (a file, or - for none): DDL a variant measures inside the transaction, so
its rollback leaves the database as it was.

Each step's backend CPU (utime + stime from /proc/<pid>/stat) and wall time are printed; `checks` is SET CONSTRAINTS
ALL IMMEDIATE, the work COMMIT would do. With pg_stat_statements tracking nested statements (track = all), the RI
queries' calls and execution time are summed by form: ri_Check_Pk_Match's lookup in the referenced table
(`SELECT 1 FROM ONLY <pk> x WHERE pkatt = $1 ...`) and ri_restrict's in the referencing one (`... WHERE $1 = fkatt`).

Usage: python3 -I measure.py <psql> <socket dir> <port> <database> <package> <track: all|none> <variant sql|->"""
import os, re, subprocess, sys, time

psql, sock, port, db, package, track, variant = sys.argv[1:8]
tick = os.sysconf("SC_CLK_TCK")
base = [psql, "-X", "-q", "-At", "-F", "\t", "-h", sock, "-p", port, "-U", "postgres"]


def q(sql, database=db):
    return subprocess.run(base + ["-d", database, "-c", sql], capture_output=True, text=True, check=True).stdout


q(f"ALTER SYSTEM SET pg_stat_statements.track = '{track}'", "postgres")
q("ALTER SYSTEM SET pg_stat_statements.track_planning = off", "postgres")
q("SELECT pg_reload_conf()", "postgres")
tables = [l.split("\t") for l in q("""SELECT c.oid, quote_ident(n.nspname) || '.' || quote_ident(c.relname),
  CASE WHEN c.oid = 'qti.package'::regclass THEN 'name' ELSE 'package' END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname IN ('qti', 'ledger') AND EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = c.oid
  AND NOT a.attisdropped AND a.attname = CASE WHEN c.oid = 'qti.package'::regclass THEN 'name' ELSE 'package' END)""").splitlines()]
oids = {t[0]: t for t in tables}
deps = {o: set() for o in oids}
for child, parent in (l.split("\t") for l in q("SELECT conrelid, confrelid FROM pg_constraint WHERE contype = 'f' AND NOT condeferrable").splitlines()):
    if child in deps and parent in oids and child != parent:
        deps[child].add(parent)
order, done = [], set()


def visit(o, path=()):
    if o in done:
        return
    assert o not in path, f"cycle at {oids[o][1]}"
    for p in sorted(deps[o]):
        visit(p, path + (o,))
    done.add(o)
    order.append(o)


for o in sorted(oids, key=lambda o: oids[o][1]):
    visit(o)
lit = "'" + package.replace("'", "''") + "'"
steps = [("begin", "BEGIN ISOLATION LEVEL SERIALIZABLE;")]
if variant != "-":
    steps.append(("variant", open(variant).read()))
steps += [(f"delete {oids[o][1]}", f"DELETE FROM {oids[o][1]} WHERE {oids[o][2]} = {lit};") for o in reversed(order)]
steps += [("checks", "SET CONSTRAINTS ALL IMMEDIATE;"), ("rollback", "ROLLBACK;")]

p = subprocess.Popen(base + ["-d", db, "-v", "ON_ERROR_STOP=0"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.STDOUT, text=True, bufsize=1)


def run(sql):
    p.stdin.write(sql.rstrip() + "\n\\echo __STEP_DONE__\n")
    p.stdin.flush()
    out = []
    for line in p.stdout:
        if line.rstrip("\n") == "__STEP_DONE__":
            break
        out.append(line)
    return "".join(out)


def cpu(pid):
    f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    return (int(f[11]) + int(f[12])) / tick


pid = int(run("SELECT pg_backend_pid();").strip().splitlines()[-1])
q("SELECT pg_stat_statements_reset()", "postgres")
q("SELECT pg_stat_reset()")
writes = [0.0, 0.0]
for label, sql in steps:
    c0, t0 = cpu(pid), time.time()
    out = run(sql)
    c1, t1 = cpu(pid), time.time()
    err = re.search(r"ERROR:.*", out)
    if err or not label.startswith("delete"):
        print(f"{label}\tcpu_s {c1 - c0:.2f}\twall_s {t1 - t0:.2f}\t{err.group(0)[:200] if err else ''}", flush=True)
    else:
        writes[0] += c1 - c0
        writes[1] += t1 - t0
print(f"deletes ({len(order)} statements)\tcpu_s {writes[0]:.2f}\twall_s {writes[1]:.2f}")
p.stdin.close()
p.wait()
time.sleep(0.5)
if track == "all":
    rows = [l.split("\t") for l in q(f"""SELECT s.calls, s.total_exec_time, s.query FROM pg_stat_statements s
JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = '{db}' AND s.query ~ '^SELECT \\$[0-9]+ FROM ONLY'""", "postgres").splitlines()]
    for form, test in (("pk match", lambda t: not re.search(r"WHERE \$1[^0-9]", t)), ("restrict", lambda t: bool(re.search(r"WHERE \$1[^0-9]", t)))):
        sel = [r for r in rows if test(r[2])]
        print(f"RI {form}\tcalls {sum(int(r[0]) for r in sel)}\texec_s {sum(float(r[1]) for r in sel) / 1000:.2f}\tstatements {len(sel)}")
print("functions\t" + q("SELECT coalesce(string_agg(funcname || ' ' || calls || ' ' || round(self_time::numeric / 1000, 2) || ' s', ', ' ORDER BY self_time DESC), 'none') FROM pg_stat_user_functions").strip())
