"""batch-judge: one run's sums (run.sh's out/<tag>/<label>/). From steps.tsv, cpustep.py's, the backend CPU of the
batch's writes (every `insert` or `delete` step) and of COMMIT, and any error. From statements.tsv, pg_stat_statements
over the measured database, the execution and planning milliseconds and the plans of each class of statement: the
batch's own statements; the foreign keys' checks (RI's `SELECT 1 FROM ONLY`); the judge's captures and its tamper
checks, which read pg_temp or pg_class; and every other, a rule's probe. From functions.tsv, the rule functions'.

Usage: python3 -I report.py <run dir>"""
import os, re, sys
d = sys.argv[1]
steps = []
for line in open(os.path.join(d, "steps.tsv")):
    f = line.rstrip("\n").split("\t")
    if len(f) < 3 or not f[1].startswith("wall_s"):
        print("unparsed:", line.rstrip()[:200])
        continue
    steps.append((f[0], float(f[1].split()[1]), float(f[2].split()[1]), f[4] if len(f) > 4 else ""))
writes = [s for s in steps if s[0].startswith(("insert ", "delete "))]
commit = [s for s in steps if s[0] == "commit"]
errors = [s for s in steps if s[3]]
print(f"writes: {len(writes)} statements, CPU {sum(s[2] for s in writes):.2f} s, wall {sum(s[1] for s in writes):.2f} s")
for s in commit:
    print(f"commit: CPU {s[2]:.2f} s, wall {s[1]:.2f} s")
for s in errors:
    print(f"ERROR at {s[0]}: {s[3]}")
top = sorted(writes, key=lambda s: -s[2])[:8]
print("costliest writes:", ", ".join(f"{s[0].split(' ', 1)[1]} {s[2]:.2f}" for s in top))
classes = {}
def classify(q):
    if re.match(r"(INSERT INTO|DELETE FROM) (qti|ledger)\.", q) or q in ("BEGIN ISOLATION LEVEL SERIALIZABLE", "COMMIT"):
        return "batch"
    if q.startswith("SELECT 1 FROM ONLY") or "FOR KEY SHARE OF" in q:
        return "foreign keys"
    if "pg_temp" in q or "pg_catalog\".\"pg_class" in q or "pg_class" in q:
        return "judge capture and checks"
    return "rule probes"
for line in open(os.path.join(d, "statements.tsv")):
    f = line.rstrip("\n").split("\t")
    if len(f) < 10:
        continue
    c = classify(f[9])
    t = classes.setdefault(c, [0, 0.0, 0.0, 0, 0, 0, 0])
    t[0] += int(f[1]); t[1] += float(f[2]); t[2] += float(f[3]); t[3] += int(f[4]); t[4] += 1
    t[5] += int(f[6] or 0); t[6] += int(f[7] or 0)
print("pg_stat_statements: class, statements, calls, exec s, plan s, plans, generic calls, custom calls")
for c, t in sorted(classes.items(), key=lambda kv: -kv[1][1]):
    print(f"  {c}\t{t[4]}\t{t[0]}\t{t[1] / 1000:.2f}\t{t[2] / 1000:.2f}\t{t[3]}\t{t[5]}\t{t[6]}")
fns = [l.rstrip("\n").split("\t") for l in open(os.path.join(d, "functions.tsv")) if l.strip()]
rule = [f for f in fns if f[0].startswith(("__rule", "__judge", "__capture"))]
print(f"functions: {len(rule)} rule/judge/capture functions, calls {sum(int(f[1]) for f in rule)}, self time {sum(float(f[3]) for f in rule) / 1000:.2f} s")
for f in sorted(rule, key=lambda f: -float(f[3]))[:6]:
    print(f"  {f[0]}\t{f[1]}\t{float(f[3]) / 1000:.2f} s")
