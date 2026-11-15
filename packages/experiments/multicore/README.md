# multicore (experiment, MULTICORE, 2026-11-15)

What it tests: whether partitioning every package-keyed relation of a grizzle schema BY LIST on its package lets
publishes of different packages run at once under SERIALIZABLE with no fence and no false 40001, so one publish
workload uses more than one core. Each package's heap and indexes become relations of their own, so SSI's coarse
predicate locks (a relation lock on a seq-scanned small heap, a whole empty btree, a leaf page two adjacent packages
share) can no longer name two packages; and what the partition DDL itself costs (its locks, its time, the catalog).

Verdict that ends it: NEGATIVE, delivered to main with the numbers below; this package is deleted in the next commit.

## Setup

edullm's QTI database at production's 62d9c0b93 (grizzle d15b3d4d, 5 migrations), migrated by `grizzle migrate` into a
private PostgreSQL 19rc1 cluster set as edullm-qti-db (RDS db.r7g.2xlarge settings, CPUQuota 800%), dumped and rewritten.
The publish is edullm's `publishPackage` through a scratch edullm's driver (IMPORTPAR's, S3 left out); the served file is
the one generate makes with KEYEDWRITE's keyed reads (0a9380be; publisher_app.json b1fc8e9e), fenced or fence-free
(IMPORTPAR's edit). media_type holds its 9 rows first (its overlap on an empty database is real, not SSI's). Packages:
alphascience g3t15, g3t06, g3t07, g3t10. cassowary, load 150-480, so CPU-seconds are the measure, wall is indicative.

- `init-cluster.sh`, `setup.sh <port>`: the cluster and the migrated database `qti` (IMPORTPAR's setup).
- `partition.py <dump> <tables> <out> <side> <list|pairs|hash>`: the rewrite (its docstring says what it changes and why
  each change keeps the schema's laws); `pairs` states each package-paired foreign key once per package instead of on
  the parents (all 1,012 pair their package columns); `hash` makes m fixed slots instead. `pairs.py` loads the pairs.
- `provision.sql`: `multicore.provision` (CREATE TABLE ... PARTITION OF), `multicore.provision_attach` (LIKE, ATTACH,
  the package's paired keys), `multicore.slots(m)`.
- `arm.sh`, `run.sh`, `report.py`, `siread.py`, `stmts.sh`: one arm, its 40001s, per-backend CPU (/proc), SIRead locks
  named by package, pg_stat_statements' calls, plans and planning time. `lockprobe.sh`: a package's partitions made
  while another's publish runs. `plancost.sql`: one statement's planning time, locks and relcache over the parents.
- `pgbug-generated-domain-check.sql`, `dropchecks.sql`: the PostgreSQL 19 defect below and the 13 CHECKs dropped for it.

## Results

| arm | schema | fence | width | 40001 | wall s | backend CPU s | plans / calls | planning s |
|---|---|---|---|---|---|---|---|---|
| KA2+KA4 | plain | yes | 1 | 0 | 311.2 | 174.4 | 5,017 / 316,093 | 8.4 |
| KB2s | plain | no | 2 | 1 of 2 | 146.9 | 147.4 | 3,748 / 195,342 | 6.7 |
| KC2 | LIST, pairs | no | 2 | 0 | 119.8 + 27.9 provisioning | 175.0 | 10,970 / 151,178 | 45.9 |
| KC4 | LIST, pairs | no | 4 | 0 | 252.7 + 61.5 provisioning | 725.4 | 81,167 / 316,084 | 434.1 |
| KC4g | KC4, generic plans (what-if) | no | 4 | 5 of 9 | 671.5 | 1,329.6 | 11,385 / 580,805 | 85.1 |
| KP43 | LIST, parent FKs, 43 packages | no | 2 | stopped | > 1,272 | > 2,491 | 102,341 / 28,503 | 2,364 |

- SSI: with keyed reads, partitioning removes the false conflicts. KC2 and KC4 (6 concurrent pairs) commit with no
  40001, and every SIRead lock each publish holds is on its own package's partitions. The plain schema loses one of two
  (KB2s, "pivot, during conflict out checking"). Without keyed reads, the OR-of-EXISTS replace reads every partition
  (relation SIReads on the other package's document_id, file, instance_name, placed_id, placed_reference, site_target)
  and the partitioned arm loses one too: keyed package-replace is necessary for any concurrency.
- CPU: 4-way partitioned is 1.23x serial's wall (0.99x with its provisioning) at 4.2x serial's CPU, 2.9 cores busy.
  Planning is the cost. A generic plan is costed with every partition and gets no credit for initial pruning
  (plancache.c:1211-1229, 1241-1285, REL_19_RC2), so custom plans win forever: KC4's top rule probe ran 26,465 calls
  and 26,469 plans. Each custom plan tests every unpruned partition's CHECKs (constraint_exclusion = partition,
  plancat.c:1906-1916): a pruned keyed read of qti.node plans in 16.8 ms warm, 0.6 ms with constraint_exclusion off
  (measurement only), 0.49 ms on the plain table. With parent-level foreign keys PostgreSQL's own RI check on qti.node
  re-plans per row too: KP43 44,972 calls, 44,974 plans, 725 s.
- Forcing generic plans (KC4g, a what-if, never a fix) cuts planning to 85 s but brings the conflicts back: a generic
  plan does not prune every access, each publish held SIReads on ~160 relations of every other package, and 5 of 9
  attempts died. No plan mode gives both: separation needs plan-time pruning, which needs a plan per call.
- Relcache and locks: a statement not prunable at plan time opens every partition: CacheMemoryContext 13 MB plain,
  215 MB (custom) / 468 MB (generic) at 43 packages, ~10.6 MB per package of qti.node; a generic plan locks all 43
  partitions at each execution (AcquireExecutorLocks, plancache.c:1916-1960; 46 locks against 4).
- Catalog per package: +1,983 relations, +13,603 attributes, +5,871 constraints (pairs: +4,849, 1,012 foreign keys),
  +4,204 triggers, +54,701 pg_depend rows (pairs: +41,280), +17 MB catalog. At 43 packages: 87,699 relations, 2.40M
  pg_depend rows, 770 MB catalog, 1.25 GB empty database; at 430, ~855k relations, ~24M pg_depend rows, ~7.4 GB catalog.
- Provisioning a package: PARTITION OF median 70 s (26-153 s over 43 packages), and while a publish ran it deadlocked
  with it (it held AccessExclusiveLock on a parent, tablecmds.c:889, and waited for ShareRowExclusiveLock on qti.section
  for a foreign key clone, tablecmds.c:12213-12216, which the publisher's RowExclusiveLock held). LIKE + ATTACH
  (ShareUpdateExclusiveLock, tablecmds.c:4878) + per-package key pairs: median 11.5 s (7.8-19.3 s), no lock wait while
  a publish ran. The per-package database phase it would parallelize: ~64 s in production, 26-63 CPU-s here.
- 8 fixed HASH slots (catalog x8 at 18,327 relations, no per-package DDL, parent-level keys) went the way KP43 did:
  the node statement ran > 600 CPU-s per backend before it was stopped (its planning share was not captured).
- External routes, for comparison (push-db): COPYMERGE ~48 min, COPYDIRECT ~67 min, against the 46-min fenced fan-out.

## Parallel query inside one publish (REL_19_RC2)

None of a publish can take a parallel plan. planner.c:424-439 allows parallel mode only for CMD_SELECT with no
data-modifying CTE; the comment at 410-418 names CREATE TABLE AS, SELECT INTO and CREATE MATERIALIZED VIEW as the
exceptions (createas.c:324, matview.c:428), safe because the new table is invisible to workers. Every publish statement
writes, or fills a TEMP carrier (CREATE TEMPORARY TABLE + INSERT ... SELECT unnest($n)), and a temp relation is never
scanned in parallel (allpaths.c:670-680); unnest is a function scan with no partial path. SERIALIZABLE is not the
obstacle (no isolation test at planner.c:424-429; parallel.c:360 shares the SERIALIZABLEXACT). PL/pgSQL plans its
statements with CURSOR_OPT_PARALLEL_OK (pl_exec.c:3645), but a rule probe is a keyed read the cost model never splits.

## What would have to change for partitioning to win

- PostgreSQL: a generic plan costed after initial pruning (or partitions locked and opened only when unpruned), so a
  pruned plan can be cached; and constraint exclusion not repeated per plan on partitions whose bounds already prune.
- PostgreSQL 19 defect, a precondition: an INSERT routed through a partitioned parent fails when a CHECK reads a STORED
  generated column of a domain type (`pgbug-generated-domain-check.sql`; rc1 and rc2; plain table and direct partition
  insert succeed; preptlist.c:457-469 gives the generated column a NULL of the base type since 7c87284940). edullm has
  13 such CHECKs on 9 tables. Either upstream fixes it, or grizzle emits domain-typed generated columns at their base
  type with the domain's check as a table CHECK, which touches the DDL generate emits, the served column types and their
  codecs, the snapshot's column types, and a migration that drops and re-adds each such column (32 in edullm).
- grizzle: every scoped relation access bound to the scope parameter so it prunes at plan time (keyed package-replace,
  0a9380be, is the first part); package-paired foreign keys stated per package; a package's partitions provisioned by
  LIKE + ATTACH in a transaction of their own before its publish; the fence locking the package's partitions alone.
- Even then the catalog grows by ~2,000 relations per package: the representation moves the cost into the catalog
  and the planner; it does not remove it.
