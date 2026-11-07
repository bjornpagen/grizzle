# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## Now: the first publish, 1.0.0-beta.1

Owner 2026-11-07: every known bug gets one focused agent now, and every agent commits its own files straight to main by
pathspec, through the commit gate. No integrator, no branches, no CHANGELOG (deleted). The plan below was triaged with
the owner: P0 lands before the publish, P1 is the publish itself, P2 follows it.

How the work runs:
- One agent per bug or cleanup item, owning named files. It commits and pushes them itself
  (`git commit -F msg -- <files>`; a concurrent commit waits for .git/index.lock; never `--no-verify`).
- Runs use half the machine. pg runs go through ~/.cache/grizzle-release/pgslot.sh, unit runs through slot.sh.
- Planted bugs live only in a scratch copy under ~/.cache/grizzle-release/ with its own install.
- 5433 is shared with the qti-pie session. Tell it before a pg-tier run, and send it every hash. It repins to grizzle's
  latest main at once.
- This work is grizzle only. Fixes due on qti-pie's side are qti-pie's own agents' work.

### P0: before the publish
- **The every-law witness** (qti-pie): a refused write's `refused.every` judges a family's drawn counts and ends at the
  slot's start (0), so it lists laws the row doesn't break and misses ones it does. The witness judges each row as the
  plan fills it, and an outcome never claims `every` with a law unjudged. Guard: the exact-`every` suite aimed at drawn
  and accumulated fields; kept cases qti-pie's p21-sum-as-condition and payroll-invalid cases 16 and 18.
- **The full run's failures**, one agent each, plus any more the run reports:
  - test/pg/fields/derived.test.ts: the model reused a row id after a migration deleted a row (test model);
  - test/unit/lower/rewrite/generated.test.ts pass-alone: the reference evaluator declines a vector comparison the
    generator draws;
  - test/types/compute/compute.test.ts: one refusal the types make unnamed;
  - test/pg/e2e-laws payroll-invalid: stated witnesses corrected to the filled-row contract (two cases wait on the
    every-law witness).
- **Planted-bug evidence the paused lanes owe:**
  - Compute.singleton: its bit at code + 1, and a NULL id giving the empty set;
  - the NULL search: round, trunc, ceil and floor refused in every host-evaluated position, and floats;
  - the fin tree box: its checked ending's planted bug and its measured case rate.
- **One clean full run on one commit:** `pnpm check`, the unit and type tiers, then the pg tier at --maxWorkers=3 with
  a pinned TEST_SEED, against a `git archive` of the commit with its own install. A failure is rerun once, alone; only a
  pure load timeout that then passes is a flake, and anything else is fixed and the whole run repeats.

### P1: the publish
- **README and SKILL.md:**
  - the `@beta` install line;
  - a "what you need to run grizzle" box;
  - the limits it doesn't state yet, each verified first: no lookaround or `\p` in str.regex, an empty-language
    pattern refused, a family's member side never a selection, a side's terms distinct, a generated NOT NULL's 23502
    naming no law, `db.explain` dropping index names;
  - SKILL.md synced on Compute.singleton, an owner written through an entry, and `refused.every`/`first`.
- **CONTRIBUTING.md:** the suites that hold each class, each with its oracle; the gate's test rules; how changes land.
- **Versions** to 1.0.0-beta.1 in packages/engine and packages/grizzle. The license is 0BSD (owner, 2026-11-07).
- **Tarballs:** `git archive` the release commit into ~/.cache/grizzle-release/, `pnpm install --frozen-lockfile
  --ignore-scripts`, then `pnpm pack` packages/engine and packages/grizzle twice and compare byte for byte; the
  package/consumer suite installs from them. The release commit's full hash goes to the owner.
- **The owner publishes.** Main hands over one line that tags the release commit, pushes the tag and runs
  `pnpm -r publish` under the `beta` tag (neither name is on npm yet).

### P2: after the publish
- **Mutation adequacy:** one seeded `pnpm mutate` sample on the release commit, in a scratch copy. Every surviving
  mutant becomes a generator arm or a written equivalence, and triage.json is pruned to the code.
- **PostgreSQL:** repin to 19rc2 on 2026-11-12 if the beta isn't out by then (pin.env, rebuild, re-init, delete the
  19rc1 build; RC2 includes the recursive-UNION hash_mem fix, so that patch goes; confirm DROP DATABASE … WITH (FORCE)
  beside parallel autovacuum and the RI fast path with a cast). Repin to 19 GA on 2026-11-19; the relcache patch is
  rebased and kept until a release includes it. Tell qti-pie first: its database lives in the cluster.
- **`bench:full` on a quiet machine.**
- **Housekeeping:** delete the lane scratch under ~/.cache/grizzle-release (about 14 GB).
- **fallow:** unused-class-member doesn't follow union narrowing, so check/params.ts ParamCell.use and useRelation need
  a usedClassMembers entry. Report it upstream, then drop the entry.
- **Test layout:** tests move into packages/*/test, with their mutate and fallow paths and the docs.
- **Sweeps under conflicting key orders,** the residues no plan avoids, which the serving judge excuses
  (test/pg/physical/serving.ts residueOf). GiST's cost model is blind to column position
  (upstream/gist-costestimate-column-position, for PostgreSQL 20); the partial B-tree sweep is PostgreSQL being right.
- **RDS IAM** against a real RDS.
- **Cross-repo, outside school hours for edullm:** grizzle's packages/testing differs from superstarter's in 43 files.
  Reconcile them, then copy the library into edullm with the shared lint standard.

## Upstream, for the owner to file
- upstream/generated-column-collation-before-planning: PostgreSQL 19 can't choose a collation for a generated column's
  comparison of two texts that read no row (42P22); grizzle folds such constants on the host.
- upstream/plpgsql-lineno-rescan: PL/pgSQL rescans the source on every location-to-line lookup.
- upstream/gist-costestimate-column-position: a pgsql-hackers reply to BUG #15408, for PostgreSQL 20.
- upstream/relcache-planned-check-and-generation: the relcache patch the pin carries.
- upstream/tsgo-zero-cpu-stall: tsgo at 0% CPU on a type error, unreproduced so far. Reproduce it without the
  effect-tsgo patch first, then file at microsoft/TypeScript.
