"""fk-delete: a variant's DDL for measure.py, run inside the measured transaction and rolled back with it. Every foreign
key into <table> whose referenced columns are plain columns that pair a referencing column with <field> is re-pointed
at a guarded landing: <table> gains a column generated STORED as `CASE WHEN <field> IN (...) THEN <guarded> END` and a
UNIQUE over the foreign key's referenced columns with <guarded> replaced by it, so a <table> row whose <field> holds a
value outside the set has a null there and PostgreSQL queues no check of that foreign key when it is deleted
(trigger.c AfterTriggerSaveEvent, ri_triggers.c RI_FKey_pk_upd_check_required). The set is the values the referencing
column holds in the database, all packages (a lower bound of what its declared domain admits).

Modes: `union`, one guarded landing per referenced column list, guarded by the union of its foreign keys' sets (each
landing replaces one UNIQUE that exists now); `each`, one guarded landing per foreign key, by its own set (one UNIQUE
more per foreign key); `drop`, the foreign keys dropped, the bound no guard can pass.

Usage: python3 -I variant.py <psql> <socket dir> <port> <database> <table> <field> <guarded> <union|each|drop>"""
import subprocess, sys

psql, sock, port, db, table, field, guarded, mode = sys.argv[1:9]


def q(sql):
    r = subprocess.run([psql, "-X", "-q", "-At", "-F", "\t", "-h", sock, "-p", port, "-U", "postgres", "-d", db, "-c", sql],
                       capture_output=True, text=True, check=True)
    return [l.split("\t") for l in r.stdout.splitlines() if l]


fks = q(f"""SELECT c.conname, c.conrelid::regclass,
  (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.i) FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n),
  (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.i) FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
     JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n),
  c.condeferrable, c.condeferred, c.confupdtype
FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = '{table}'::regclass
  AND NOT EXISTS (SELECT FROM unnest(c.confkey) k(n) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n
    WHERE a.attgenerated <> '' OR NOT a.attnotnull)
ORDER BY 2, 1""")
chosen = []
for name, src, cols, refcols, deferrable, deferred, onupdate in fks:
    c, r = cols.split(","), refcols.split(",")
    if field not in r or guarded not in r:
        continue
    held = sorted({int(v) for (v,) in q(f"SELECT DISTINCT {c[r.index(field)]} FROM ONLY {src}")})
    chosen.append((name, src, c, r, deferrable == "t", deferred == "t", onupdate, held))
out = [f"-- {mode}: {len(chosen)} foreign keys into {table}"]
landings = {}
for i, (name, src, c, r, deferrable, deferred, onupdate, held) in enumerate(chosen):
    out.append(f"ALTER TABLE {src} DROP CONSTRAINT {name};")
    if mode == "drop":
        continue
    key = ",".join(r) if mode == "union" else f"{i}"
    landings.setdefault(key, (r, set(), []))[1].update(held)
    landings[key][2].append((name, src, c, deferrable, deferred, onupdate))
for n, (r, held, uses) in enumerate(landings.values()):
    col = f"__fkdelete_guard_{n}"
    values = ", ".join(str(v) for v in sorted(held)) or "NULL"
    out.append(f"ALTER TABLE {table} ADD COLUMN {col} bigint GENERATED ALWAYS AS (CASE WHEN {field} IN ({values}) THEN {guarded} END) STORED;")
    landed = [col if x == guarded else x for x in r]
    out.append(f"ALTER TABLE {table} ADD CONSTRAINT {col}_key UNIQUE ({', '.join(landed)});")
    for name, src, c, deferrable, deferred, onupdate in uses:
        timing = (" DEFERRABLE" + (" INITIALLY DEFERRED" if deferred else "")) if deferrable else ""
        update = " ON UPDATE CASCADE" if onupdate == "c" else ""
        out.append(f"ALTER TABLE {src} ADD CONSTRAINT {name} FOREIGN KEY ({', '.join(c)}) REFERENCES {table} ({', '.join(landed)})"
                   f"{update}{timing} NOT VALID;")
print("\n".join(out))
