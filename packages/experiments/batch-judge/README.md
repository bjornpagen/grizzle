# batch-judge (experiment, BULKLOAD-BATCH, 2026-11-15)

What it tests: which form of rule judgement a batched publish should take. k packages' rows are written in one
SERIALIZABLE transaction, for k = 1, 8 and 43 (edullm's whole QTI corpus). One arm runs grizzle main's per-row
judgement: a deferred constraint trigger per rule and table, FOR EACH ROW. The other runs the set judge
(`judge.patch`): statement-level captures with transition tables fill a per-session delta, and one deferred trigger
runs every rule's probe once at COMMIT over those rows, each probe navigated from its region (analysis/theory/navigate.ts
starting the chain at the delta). Both installations are edullm staging's QTI database, generated over the same grizzle
commit, with identical tables and indexes. The backend CPU is split into the writes, COMMIT's judgement and the
planning of the statements judgement runs, with and without statistics. Real served single-package publishes of
both arms come beside the batches.

Verdict that ends it: main decides from the numbers which form batched publishing keeps, and the winner lands with its
oracle and plants, or the judge is dropped. Then this package is deleted in one commit.

Nothing here is code grizzle runs. No test reads it. The working directory is `$BATCH_WORK`, by default
`~/.cache/grizzle-release/BULKLOAD/batch` (edullm trees, clusters, secrets, `out/<tag>/`).

- `tree.sh <tree> <arm> <grizzle rev> [<grizzle patch>] [<edullm rev>]`: an edullm clone with vendor/grizzle at the
  commit (and the patch in its working tree), edullm-repin's `edullm-port.patch`, `edullm-overlay.patch` (the local
  publish and migrate config, the database an input), installed, and `grizzle generate --name batch-<arm>`.
- `judge.patch`: the set judge on grizzle main, rebased from BULKLOAD's stopped commits (SQL tree and printer for
  transition triggers and session tables; captures, sentinel and `__judge`, physical/ddl/rules.ts), with the probe over
  its region built from the per-row probe (analysis/theory/query.ts regionQuery) and navigated, and `grizzle generate`
  compiling the judged installation.
- `init-cluster.sh`, `setup.sh <tag> <port> <tree>`, `passwords.sh`: a production-shaped 19rc1 cluster (RC1TARGET's
  prefix, db.r7g.2xlarge's settings, CPUQuota 800%, autovacuum off) and the tree's migrations.
- `stage.sh <tag> <port> <tree> <lanes>`: each of the 43 packages published once, per-row, into a database of its own;
  `stagecpu.sh <tag>`: each publish's server CPU before and at COMMIT; `gather.sh <tag> <port>`: their rows gathered
  into schema src of the template database; `copysrc.sh`: the same rows into the other arm's template.
- `base.sh <tag> <port> <name> <packages> <stats|nostats> [<template>]`: a base of stored packages, loaded with triggers
  off, with or without VACUUM ANALYZE.
- `batchsql.py`, `cpustep.py`, `run.sh <tag> <port> <base> <label> <insert|delete> <packages>`, `report.py`: one batch
  in one transaction, each step's backend CPU, pg_stat_statements' planning and execution by class of statement.
- `plan.sh <tag> <port> <sets>`: every base and batch of one arm; `all.sh`: the per-row arm's served k = 1, the gather,
  the batched publish's migration on both arms, the copy, then both plans.
- `served.sh <tag> <port> <tree> <label> <name>...`, `sessioncpu.py`: real served publishes, CPU before and at COMMIT.
- `batchpublish.py <tree>`: edullm's batched publish written into a scratch tree (pantry's `replaceWrite` and the
  publisher's published keys over a relation parameter `packages`, `publishPackages`, `importpar-batch.ts`);
  `servedbatch.sh <tag> <port> <tree> <label> <base> <packages>`: one real served batch.
