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
Owner 2026-11-07, later the same day: passing tests are no longer required to publish, and grizzle fixes only bugs qti-pie
triggers or that root in grizzle and affect it. Beta.1 must also lift the limits qti-pie named, each fixed in grizzle,
never as a hack downstream. Every hash goes to qti-pie, which repins at once.
- **qti-pie's limits, one agent each:**
  - #1 a candidate key over a STORED generated column, compared in the write's own statement (Q1);
  - #2 a containment source with constant terms and a field read twice (Q2);
  - #3 a fold step or generated term under another refinement of its carrier, refused by the target domain (Q3);
  - #5 messageMaxBytes and maxStringLength exported (landed, 8a7c03ab);
  - #7 `lawsOf(schema)` and `sameLaw` (EXP).
- **The fallback audits:** FB-L and FB-A finish and push.

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
- **Test failures that reach no qti-pie path** (each an after-beta agent):
  - test/unit/deploy/split.test.ts floor case 13: the SQL lexer stops at a zero-length quoted identifier `""`;
  - test/unit/physical/executes.test.ts and test/pg/physical/executes.test.ts: "a constant only a written table's casts
    reach" is never reached;
  - test/pg/closed/fin.test.ts: C.at's generated field at an absent key now gives 23502, and the test still expects 23514
    (stale since 0e4454d3);
  - test/pg/migrate/paths.test.ts intents (replay 'pg/migrate/intents:-:0.a.0.1.9.0.0.0.0.0.0.0.0.0'): after
    removeLastHandle then renameRoster, the roster domain's CHECK calls a names constant other than the one the test
    expects. A possible rename defect, so it goes first;
  - test/pg/substrate/tree.ts clearSql is a DELETE; make it TRUNCATE, as fin.ts does;
  - test/types/compute: building the program synchronously blocks vitest's worker-start timer under heavy load.
- **Leftovers from the fallback audits:** in edit.ts, a fold `where` that fails to evaluate is refused as integerRange
  where the nested path says factShape; WrittenOver's "description" arm exists only for test/support/describe.ts; the
  re-insert witness residual (a stored owner re-inserted beside a refused new owner).
- **role's base type admits a role value** (AnyRole extends AnySchema) that the runtime then refuses as malformed: an
  illegal state the types still represent (found by FULLROLE).
- **qti-pie's other limits:** #8 float cast totality past the double form, and a containment whose source is a join.
- **bytes past 268,435,443 bytes:**
  - Why: pg 8.23's parser decodes every result cell as a UTF-8 string, so a binary read isn't possible. Every bytes
    value is read as hex text in one string.
  - The design (BYTES, 2026-11-07), still one statement:
    - every outermost select that delivers a bytes column is cross-joined with generate_series over chunks of a
      measured Limit, delivering `encode(substring(col FROM i*C+1 FOR C), 'base64url')`, with octet_length and the
      other columns on chunk 0;
    - the reader groups rows by ordinal into one Uint8Array, filled with setFromBase64;
    - a value's identity becomes its windows-1252 decode, so about 512 MiB;
    - a digest key with an exact compare on a hit would reach about 1 GB.
  - The riskiest part is the attachment stitching.
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
