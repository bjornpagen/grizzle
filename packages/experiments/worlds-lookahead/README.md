# worlds-lookahead (experiment, WORLDSCPU, 2026-11-15)

What it tests: whether a change to the worlds model's look-ahead (generate/enumerate.ts's box, features.ts featuresOf,
laws/model.ts's transition) leaves every box and every offered action's reached features as they were, and where the
look-ahead spends its time. `node packages/experiments/worlds-lookahead/walk.ts <out> <walks>` writes one SHA-256 per
box and per offered action's ordered features over drawn walks of the model; run it before and after a change and
compare the files (`walk.ts - <walks>` under `node --cpu-prof` profiles the look-ahead with no PostgreSQL).
`cpu.config.ts` is the network tier's config with `cpu-setup.ts` in every test process, which appends each file's CPU
seconds to `$WORLDSCPU_CPU`: the worker time a before/after run of the network files compares. It reads the
network config through the root's `#vitest.network.config.ts` import, which goes with this package.

Verdict that ends it: WORLDSCPU's second round of worlds CPU cuts lands with identical walk files before and after;
the commit after that deletes this package.
