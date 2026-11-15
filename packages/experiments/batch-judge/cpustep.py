"""batch-judge (BULKLOAD's): runs SQL steps in one psql session against one database and reports, for each step, its wall seconds
and the backend process's CPU seconds (utime + stime of /proc/<pid>/stat, so machine load does not inflate it), with
the step's output saved to <outdir>/<label>.out. A step file holds blocks separated by lines `-- step: <label>`; each
block runs as given (EXPLAIN ANALYZE, PREPARE, ANALYZE ...), the first line of output after `Execution Time` kept.

Usage: python3 -I cpustep.py <psql> <socket dir> <port> <database> <steps.sql> <outdir>"""
import os, re, subprocess, sys, time
psql, sock, port, db, steps_path, outdir = sys.argv[1:7]
os.makedirs(outdir, exist_ok=True)
tick = os.sysconf("SC_CLK_TCK")
p = subprocess.Popen([psql, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=0", "-h", sock, "-p", port, "-U", "postgres", "-d", db],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

def run(sql):
    p.stdin.write(sql.rstrip() + "\n\\echo __BATCH_DONE__\n")
    p.stdin.flush()
    out = []
    for line in p.stdout:
        if line.rstrip("\n") == "__BATCH_DONE__":
            break
        out.append(line)
    return "".join(out)

def cpu(pid):
    f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    return (int(f[11]) + int(f[12])) / tick

pid = int(run("SELECT pg_backend_pid();").strip().splitlines()[-1])
blocks = re.split(r"^-- step: (.+)$", open(steps_path).read(), flags=re.M)
for label, sql in zip(blocks[1::2], blocks[2::2]):
    label = label.strip()
    c0, t0 = cpu(pid), time.time()
    out = run(sql)
    c1, t1 = cpu(pid), time.time()
    open(os.path.join(outdir, label.replace(" ", "_") + ".out"), "w").write(out)
    ex = re.search(r"Execution Time: ([0-9.]+) ms", out)
    err = re.search(r"ERROR:.*", out)
    print(f"{label}\twall_s {t1 - t0:.2f}\tcpu_s {c1 - c0:.2f}\texec_ms {ex.group(1) if ex else '-'}\t{err.group(0)[:120] if err else ''}", flush=True)
p.stdin.close()
p.wait()
