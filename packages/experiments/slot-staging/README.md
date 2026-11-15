# slot-staging (experiment, BULKLOAD-STAGE, 2026-11-15)

What it tests: what staging each member slot two statements read into one carrier (packages/engine/src/write/program/
slot-carriers.ts) does to one real QTI publish, before (grizzle without it) and after: the bytes the client writes to
its session, the client's CPU before and during the write flight, the server's CPU per statement, and the stored rows,
md5 per table, which must be identical.

- `procio.py <timeline.tsv> <command...>`: runs the publish and samples its process every 20 ms: CPU (utime + stime) and
  wchar, the bytes it writes by syscall, which for a publish process is its one TLS session to PostgreSQL. It prints the
  totals and the write flight's bytes, wall time and the CPU just before and after it.
- `run.sh <tag> <port> <scratch edullm> <package dir> <name>`: one publish into a cluster BULKLOAD's setup.sh made, every
  statement logged with its backend CPU (log_statement_stats), the process sampled by procio.py, then every table's md5
  under one REPEATABLE READ snapshot.
- `names.py <served login json>`: each served statement's prepared name, kind and relation, as BULKLOAD's logstats.py
  joins the log's statements to the program.
- The clusters and the per-statement server CPU are BULKLOAD's harness under ~/.cache/grizzle-release/BULKLOAD/scripts
  (setup.sh, logstats.py), over a scratch edullm (FAMWRITE's recipe: a clone at staging, vendor/grizzle checked out at
  the tree measured, `grizzle generate`).

Verdict that ends it: main has the before and after numbers for g3t01 and a shadow bank from BULKLOAD-STAGE's report and
accepts or refuses the staging. Then delete this package in one commit.
