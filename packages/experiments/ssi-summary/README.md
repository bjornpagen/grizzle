# ssi-summary

What it tests: that PostgreSQL 19 fails a lone SERIALIZABLE writer with 40001 ("Canceled on identification as a pivot,
with conflict out to old committed transaction"), with no other writer of its tables, once SSI has summarized its own
earlier write while another transaction holding an xid keeps the cluster's horizon back. grizzle's README states this
case and that the 40001 is safe to run again (a `transient` `CallError`, or `grizzle migrate` resuming its folder).

The mechanism, REL_19_0: the writer's shrink writes a row its grow read, and the grow, a full committed transaction,
counts as concurrent because the shrink's snapshot xmin precedes the grow's finishedBefore (predicate.c 4157, 4170); the
shrink then reads versions its write created, and the write, summarized, is looked up with no concurrency test
(predicate.c 3980-4012, heapam.c 9504-9555).

Run it as a unit: `systemd-run --user -d -u grizzle-ssi-summary --slice=grizzle.slice --wait --
packages/experiments/ssi-summary/run.sh`. It starts the workbench's cluster of its own, `postgres@grizzle-ssi-summary`, and
stops it at the end, never touching the shared server. It fills the pool of finished SERIALIZABLE transactions twice
over, ten transactions for each backend slot the cluster's settings make. The holder is a psql session idle in its
transaction, which runs the fill and the writer's sequence from its own `\!`, so nothing runs in the background.

Verdict that ends it: `run.sh` exits 1, the shrink committing with the horizon held, on a PostgreSQL grizzle pins. Then
delete this package and the README sentence that cites it, in one commit.
