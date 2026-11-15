"""fk-delete: the deferred foreign key checks a whole-package delete queues, counted per foreign key from the stored
rows, without deleting anything. A DELETE of a referenced row queues one NO ACTION event per foreign key into its table
whose referenced columns all hold a value there (PostgreSQL 19 trigger.c AfterTriggerSaveEvent, ri_triggers.c
RI_FKey_pk_upd_check_required). Each event runs ri_Check_Pk_Match on the referenced table, then the restrict query on
the referencing one (ri_restrict). An event whose referenced row no referencing row names finds nothing: `vacuous`.

Prints one line per foreign key: referenced table, referencing table, referenced columns, events, referenced (rows some
referencing row names), then the totals by referenced table.

Usage: python3 -I census.py <psql> <socket dir> <port> <database> <package>"""
import subprocess, sys

psql, sock, port, db, package = sys.argv[1:6]


def q(sql):
    r = subprocess.run([psql, "-X", "-q", "-At", "-F", "\t", "-h", sock, "-p", port, "-U", "postgres", "-d", db, "-c", sql],
                       capture_output=True, text=True, check=True)
    return [l.split("\t") for l in r.stdout.splitlines() if l]


lit = "'" + package.replace("'", "''") + "'"
fks = q("""SELECT c.oid, c.confrelid::regclass, c.conrelid::regclass,
  (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.i) FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
     JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n),
  (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.i) FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n),
  (SELECT string_agg(a.attname, ',') FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname IN ('package', 'name')
     AND NOT a.attisdropped)
FROM pg_constraint c WHERE c.contype = 'f' ORDER BY 2, 3, c.oid""")
totals = {}
for oid, pk, fk, pkcols, fkcols, keyed in fks:
    unit = "package" if "package" in keyed.split(",") else ("name" if pk == "qti.package" else None)
    if unit is None:
        continue
    pkc, fkc = pkcols.split(","), fkcols.split(",")
    notnull = " AND ".join(f"t.{c} IS NOT NULL" for c in pkc)
    match = " AND ".join(f"x.{f} = t.{p}" for p, f in zip(pkc, fkc))
    events, referenced = q(f"""SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT FROM ONLY {fk} x WHERE {match}))
FROM ONLY {pk} t WHERE t.{unit} = {lit} AND {notnull}""")[0]
    print(f"{pk}\t{fk}\t{pkcols}\t{events}\t{referenced}", flush=True)
    t = totals.setdefault(pk, [0, 0, 0])
    t[0] += 1
    t[1] += int(events)
    t[2] += int(referenced)
print("-- totals: referenced table, foreign keys, events, referenced")
for pk, (n, e, r) in sorted(totals.items(), key=lambda kv: -kv[1][1]):
    print(f"{pk}\t{n}\t{e}\t{r}")
print(f"all\t{sum(t[0] for t in totals.values())}\t{sum(t[1] for t in totals.values())}\t{sum(t[2] for t in totals.values())}")
