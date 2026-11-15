"""digests.py <server log> <per-file.tsv> <per-file log prefix>: each test file's installations by content.

Reads the DDL statements a member logged (log_statement = 'ddl'), each a simple query's `statement:` or an extended
query's `execute <name>:`, groups each one under the first generated schema it
names (gz_<label>_<pid>_<n>_<rand>, a leading `grizzle_admission_<hex>` left as written), a CREATE SCHEMA of a name
beginning a new installation of it (the oracle runner installs each case under the one name its test holds), with every
generated name replaced by its label alone, so two installations of one schema's SQL read alike. Each file's window is its run as its
own run log's last write, less the seconds per-file.tsv says it ran. A line a file: the file, its window
(UTC), the installations it made, the distinct digests among them, and the DDL statements it sent.
"""
import hashlib
import os
import re
import sys
from datetime import datetime, timedelta, timezone

log_path, tsv_path, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
entry = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) UTC \[\d+\] (\w+):  (.*)$")
generated = re.compile(r"gz_([a-z]+)_\d+_\d+_\d+")
created = re.compile(r"^\\s*CREATE SCHEMA ", re.I)
sent_statement = re.compile(r"^(?:statement|execute [^:]*): (.*)$", re.S)
statements = []
current = None
with open(log_path, errors="replace") as log:
    for line in log:
        m = entry.match(line)
        if m:
            if current is not None:
                statements.append(current)
            current = None
            sent = sent_statement.match(m.group(3))
            if m.group(2) == "LOG" and sent is not None:
                at = datetime.strptime(m.group(1)[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                current = [at, sent.group(1)]
        elif current is not None:
            current[1] += "\n" + line.rstrip("\n")
    if current is not None:
        statements.append(current)

for row in open(tsv_path):
    file, ran = row.split("\t")[0], int(row.split("\t")[1])
    run_log = f"{prefix}.{file.split('/')[-1]}.log"
    end = datetime.fromtimestamp(os.path.getmtime(run_log), timezone.utc)
    begin = end - timedelta(seconds=ran)
    installations = []
    latest = {}
    count = 0
    for at, sql in statements:
        if begin <= at <= end:
            count += 1
            m = generated.search(sql)
            if m is None:
                continue
            name = m.group(0)
            if name not in latest or created.match(sql):
                latest[name] = len(installations)
                installations.append([])
            installations[latest[name]].append(generated.sub(lambda g: "gz_" + g.group(1), sql))
    digests = {hashlib.sha256("\n".join(v).encode()).hexdigest() for v in installations}
    print(f"{file}\t{begin:%H:%M:%S}-{end:%H:%M:%S}\t{len(installations)}\t{len(digests)}\t{count}")
