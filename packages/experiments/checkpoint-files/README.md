# checkpoint-files (experiment, IDLEXACT, 2026-11-15)

What it tests: which test-support objects of the network tier make each cluster's checkpointer sync hundreds of
thousands of files a checkpoint. In the c32/c16 tiers of 2026-11-14 every member's checkpoints ran back to back, each
syncing 77k to 333k files, the longest 2296 s, while a member holds some 3000 files at rest. A checkpoint syncs each
file written since the last one that still exists when its sync runs, so the files that count are those the run
creates and keeps across a checkpoint. The sampler counts, every interval, each database's files and each schema
label's relations (the label is the schema name's `gz_<label>_` lead, which says what made it), beside the members'
checkpoint lines. The verdict ends it: the representation that makes a case touch fewer files, or the finding that
the files are not the tests' to touch and what the cluster may do instead. Then this package is deleted in one commit.

## Run

```sh
TEST_SEED=<seed> packages/experiments/checkpoint-files/ab.sh <out> <family-on> <family-off> <file>...
TOOLCHAIN_PG_CLUSTER=<cluster> packages/experiments/checkpoint-files/sample.sh <port> <out> <seconds>
TOOLCHAIN_PG_CLUSTER=<port> TEST_SEED=<seed> packages/experiments/checkpoint-files/per-file.sh <seconds> <out> <file>...
python3 -I packages/experiments/checkpoint-files/digests.py <member's server log> <out> <out>
```

- `sample.sh`: one member, as its bootstrap superuser, appended to `<out>` until killed: `F <time> <database> <files>`
  for every database, and `R <time> <database> <label> <relations>` for every database but the templates.
- `per-file.sh`: each test file alone on the family's first member (one worker), at most `<seconds>`, in a process
  group of its own, between two CHECKPOINTs; a line a file of the files its member's checkpoints synced meanwhile.
- `digests.py`: with `log_statement = 'ddl'` set on that member while per-file.sh ran, each file's installations,
  each its schema's statements with its generated name normalized, and the distinct digests among them.
- `ab.sh <out> <family-on> <family-off> <file>...`: the same files at once on two families, the second's members set
  to `fsync = off` first, every member's waits sampled each second (`waits.sh`), and each member's checkpoint lines
  over the run kept beside each family's output and wall time.

## Findings so far (2026-11-15, private family 5797, REL_19_RC2)

- An index build registers its fork for a checkpoint fsync (bulk_write.c:218), and a dropped or aborted relation's
  first main-fork segment keeps its pending fsync as a truncated tombstone until the next checkpoint (md.c:90): about
  four synced files per table a case creates, rolled back or not; a TRUNCATE the same; a kept table a case writes about
  two.
- The heavy suites draw a new schema for nearly every case (write/oracle-0: 424 installs, 424 digests in 240 s; only
  migrate/ledger repeats one, 16 digests in 228 installs), so installing once per digest saves them little.
