# multicore (experiment, MULTICORE, 2026-11-15)

What it tests: whether partitioning every package-keyed relation of a grizzle schema BY LIST on its package lets
publishes of different packages run at once under SERIALIZABLE with no fence and no false 40001, so one publish
workload uses more than one core. Each package's heap and indexes become relations of their own, so SSI's coarse
predicate locks (a relation lock on a seq-scanned small heap, a whole empty btree, a leaf page two adjacent packages
share) can no longer name two packages; and what the partition DDL itself costs (its locks, its time, the catalog).

The schema is edullm's QTI database at production's 62d9c0b93 (grizzle d15b3d4d), migrated by `grizzle migrate` into
a private PostgreSQL 19rc1 cluster set as edullm-qti-db (RDS db.r7g.2xlarge settings, CPUQuota 800%), then dumped and
rewritten. The publish is edullm's `publishPackage` through a scratch edullm's driver (IMPORTPAR's, S3 left out).

- `init-cluster.sh`, `setup.sh <port>`: the cluster and the migrated database `qti` (IMPORTPAR's setup).
- `partition.py <dump> <tables> <out> <side> [pairs]`: the rewrite (its docstring says what it changes and why each
  change keeps the schema's laws); `pairs` states each package-paired foreign key once per package instead of on the
  parents. `pairs.py` loads those pairs into the database.
- `provision.sql`: `multicore.provision(package)` (CREATE TABLE ... PARTITION OF) and
  `multicore.provision_attach(package)` (CREATE TABLE ... LIKE, ATTACH PARTITION, then the package's paired keys).
- `arm.sh <tag> <template> <served> <width> <idx...>`: one arm on a fresh clone of a template database, the served
  file fenced (as generated) or free (IMPORTPAR's edit, no LOCK TABLE), `run.sh` publishing and sampling, `report.py`
  summarizing (40001s, wall, per-backend CPU from /proc, the cluster scope's CPU).

Verdict that ends it: the numbers are in main's hands with a verdict on partitioning (and, if positive, the design
note for grizzle's physical design). Then this package is deleted in one commit.
