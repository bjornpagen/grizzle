# edullm-repin

Tests edullm's repin onto a grizzle main commit: that the repin's migration draft of edullm's QTI database (and of
pantry's own installation) is the change production should take, and what it costs there. The verdict that ends it:
push-db applies the repin on production, or main replaces it. Then this package is deleted in one commit.

One command, from a grizzle checkout: `bash packages/experiments/edullm-repin/run.sh <grizzle rev> [<edullm rev>]`.
Its working directory is `$REPIN_WORK`, by default `~/.cache/grizzle-release/REPIN`, which holds the edullm clones, the
clusters, their secrets and `out/<grizzle short>/`. Nothing here is code grizzle runs. No test reads it.

- `port.sh`: in a clone of edullm at `<edullm rev>` (default origin/staging), vendor/grizzle at `<grizzle rev>` and
  vendor/toolchain at the commit grizzle pins, `edullm-port.patch` applied, `grizzle generate --name repin-grizzle-main`
  for the QTI database's Ledger and for pantry's QtiQueries, then `grizzle check` of both, toolchain-pin:check and
  edullm's `pnpm check`. It writes `edullm-repin.diff` (`git apply --index` on `<edullm rev>`, gitlinks included), the
  drafts' sha256s and `shape.txt`.
- `edullm-port.patch`: the edullm source the repin needs. toolchain-pin.ts lists the vendored packages with a
  `:(glob)` pathspec, so grizzle's `packages/experiments/<name>` is not read as a package directory.
- `shape.py`: the draft's statements by file and kind, each with the lock PostgreSQL documents for it and the table it
  touches. Every statement that reads stored rows is priced at production sizes. Those sizes come from the 43 packages'
  dry-run row counts (AXISINDEX) and DBSIDE's production snapshot. With `locks.tsv`, it also lists the locks each file
  was seen to hold.
- `trees.sh`: the base tree (`<edullm rev>` as committed, the production chain's grizzle) and the run tree (a fresh
  clone with the diff applied, as push-db would apply it).
- `arms.sh`: two 19rc1 clusters shaped as edullm-qti-db (`init-cluster.sh`, `setup.sh`: RC1TARGET's prefix, RDS's
  parameter formulas for db.r7g.2xlarge, CPUQuota 800%). The base arm migrates the committed chain. The repin arm
  migrates the same chain and then the draft (`migrate.sh`, whose lock probe applies each file inside a transaction on
  a clone and reads pg_locks before COMMIT). Each arm imports alphascience g3t15 and then g3-science-shadow-g3-15
  (`arm.sh`, `run-profile.sh`, `edullm-overlay.patch`'s importpar-publish.ts). After each import, every table's md5 is
  taken over the columns both arms hold (`columns.sh`, `intersect.py`, `table-md5.sh`). `compare.py` sets the arms
  side by side, with publish wall time and the CPU of each statement and of COMMIT (`sessioncpu.py`).
- `migratecost.py`: where the local `grizzle migrate` spent its time: in the draft's files, in the drift check's
  scratch replay, or in grizzle's bookkeeping.
