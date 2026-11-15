# cluster-share

Measures how many network test files one local cluster should run at once (packages/pg/src/family.ts `filesPerCluster`,
c\*). Two checkouts that differ only in that value run the whole network tier at once, at one seed, each on a private
family of its own, while every member's pg_stat_activity is sampled each second. Their wall times, the times of the
files both runs passed, and the members' SSI waiters, safe-snapshot waits and freeze windows decide c\*. The
filesPerCluster verdict ends this experiment: its measured Limit cites this package's commit, and the next commit
deletes the package.

## Run

Each checkout is a clone of grizzle at one commit, `pnpm install --frozen-lockfile` run in it, `tag.sh <tree>` applied
(it tags each session with its test file), and the value under test set in its packages/pg/src/family.ts. Each family
is made from its own checkout (`GRIZZLE_PG_CLUSTER=<free port> pnpm pg:init`, then `pnpm pg:doctor`), so its member
count is that checkout's. Run outputs go outside the repository.

```sh
TEST_SEED=<seed> packages/experiments/cluster-share/pair.sh <out> c32 <tree-32> <port-32> c16 <tree-16> <port-16>
packages/experiments/cluster-share/compare.sh <out> c32 c16 <file excluded on both sides>...
```

- `sample.sh <port> <out>`: one member's samples, rows S, D, W, C each second (activity.sql) and R every ten seconds
  (serializable.sql).
- `tier.sh <tree> <name> <out> [files...]`: the tier on the family GRIZZLE_PG_CLUSTER names, every member sampled.
- `pair.sh <out> <name-a> <tree-a> <family-a> <name-b> <tree-b> <family-b> [files...]`: two tiers at once, over the same
  files.
- `summarize.sh <samples>...`: each member's averages, oldest transactions and safe-snapshot waits.
- `compare.sh`: both runs' failures (deadline cuts apart from failures), their members, the files both passed, and the
  freeze windows.
