# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## After 1.0.0-beta.1

1.0.0-beta.1 is on npm (2026-11-08), tagged v1.0.0-beta.1 at 2e979b3c. Main carries the README rewrite and the
post-beta swarm's fixes for the next release.

### After the qti-pie and edullm repin (the owner, 2026-11-08: ship the repin first)
- **The beta.2 gate (owner, hard):** one full suite run (check, unit, types, PostgreSQL, deep) and `bench:full`, with
  every performance gate passing, both perfect on the exact commit; then the owner's go.
- **Multi-schema follow-ups:** the guards, the planted bugs and every PostgreSQL suite's multi-level fixtures, landed
  after its first commit.
- **Stopped 2026-11-08 to focus on speed, resume before the full verification run:**
  - test/pg/world-model/inductive hangs over 1h (TEST_SEED=3194260561; the old token no longer reproduces). Suspect the
    lead look-ahead in test/support/worlds/generate/action.ts waysOf; profile it under --inspect.
  - test/pg/physical/world-serving: witness precheck reads 42 buffers over its 32 bound. The cause: since dc942ebc the
    world functions' first calls per session are custom-planned, and their planning buffers count in the caller; the
    judge must allow each body's planning buffers. Its readingOf also holds a cost-chosen index to the filter-count
    rule. A shared judgeScan is drafted: ~/.cache/grizzle-release/INDEXSERVE/worldW2.patch (against c0a7b1c7) and
    msgW.txt. Separately, with the DocsLevel base a role's view read fails `column "user" does not exist`
    (TEST_SEED=1723739030, replay in the lane's report).
  - test/pg/api-errors/apply-errors: the test passes the whole fact, its key included, as the parameters argument,
    which readParams has refused whole as factShape since e9227afd (correctly). A verified test-only fix is in
    ~/.cache/grizzle-release/APIERR/APIERR.patch with commit-msg.txt; apply with --3way and re-run root oxlint.
  - Tests cull: the deferred test-only exports (CompileReasonTag, TransientTag, queryValueDesc, continued,
    ReaderValue), real test-only code in production, fallow dupes in test/, @internal tags in tests, the W6.Q10 title,
    and pg/fin/plans and pg/substrate/tree still checking generic plans of named statements that no longer exist.
  - The shell cull's RefreshReport and populatedSql (a statement per schema only tests read).
    Resume from ~/.cache/grizzle-release/CULL-SHELL/wip-e/e.patch (allowance and generated-1/2 runs left).
  - bench write-laws gate: a null payload in derived_roster (23502), pre-existing.
- **Waste hunt (remove work, never add machinery):**
  - Building qti-pie's Qti schema value costs about 36 s, a third of it grizzle's construction: ir/shape parse,
    schema/relation closedRows and admitClosedRelation, core/canonical, protocol rosterHandlesOf. The profile is
    ~/.cache/gr8des/prof/CPU.20261108.180041.75112.0.001.cpuprofile; Qti is the benchmark.
  - Rules over queries: commit time grows with the square of the rows written (8k rows × 5 tables ≈ 113 s against
    0.33 s with native foreign keys), though each probe alone is index lookups.
  - The runtime's snapshot in a file of its own (main, 2026-11-09: after the qti-pie hash and the larger waste items,
    coordinated with edullm). An application imports the whole snapshot.json for DbLayer.make (23.6 MB on Qti), and
    the layer reads about 1.9 MB of it (deploy/snapshot/served.ts): the fingerprint, the levels, constraintToLaw, the
    rosters' codes, the extensions and the grants on schemas. Split the file, duplicating nothing: the runtime's part
    and the migration's part (the DDL manifest, the theory's tables and laws, the logins, the workload access, the
    access paths) become two files under the one fingerprint, which digests both, and only generate, check and migrate
    read the migration's part. On Qti the import's JSON.parse falls from 107 to 8 ms of CPU (edullm measured the
    import at 0.4 s, 118 ms of it GC, with a 266 MB heap after it). It changes the import line qti-pie, edullm, the
    README and the SKILL use.
  - A workload member states whether it pages (main, 2026-11-09: proposed, not tonight). The layer compiles every
    ordered program of a login's workloads twice, once for rows and once as a page (adapter/reader/reader.ts
    compileReadForm builds the page template up front, so a handle's .page is ready), though an app may never page it:
    qti-app only executes its one ordered program, `tests`, about 0.1 s of DbLayer.make's CPU on edullm's profile
    (REPORT-2 G9). Compiling the page per .page call instead is refused (a compile on every hot-path page request).
    The representation: a page program is declared as one in the workload (a page entry built from the ordered
    query, its page template compiled once at startup), and a plain ordered program offers execute and get only, its
    typed handle without .page, so no form compiles a page nobody declared. It changes the workload builder and the
    Compiled handle types (README, SKILL), and qti-pie's and edullm's workloads only if they page a program.
- **A key over exactly the primary key's fields states the primary key's law, plain as span:** the draft and migration
  probe are in ~/.cache/grizzle-release/LAWSTMT/step2. It still needs its PostgreSQL run and a migration guard for a
  foreign key into the dropped redundant span UNIQUE.
- **One statement per write stratum (waste):** the write executor keeps carriers (a TEMPORARY table per write) and the
  sequential realization, with UnorderableStratum refusing what it cannot order. Making every stratum one statement
  (sibling data-modifying CTEs reading the stratum's state) deletes both, but rewrites the insert, put, delete, serial
  and entry protocols (4-5k lines). Deferred 2026-11-08 behind ONERTT-WRITE's one-flight family writer (F2).
- **A non-finite Decimal head literal in a derived relation a rule reads:** ±Infinity, NaN or past 1000 digits, read
  by a check, key or selection, still fails closed (a literal never stands first). Closing it needs engine-built
  queries to carry InferredFieldDesc literal types through their own refs and decode path, apart from authored ones.
- **A Compute term that splits a text (qti-pie, 2026-11-08, after the cold-start cuts):** no substring, split_part or
  pattern group exists, so pantry splits on the host and writes the pieces as rows (IDREF, header and tolerance tokens,
  identifier leads and trails, href pieces, reading segments, unordered pairs). It must be total under a matches
  guard, IMMUTABLE, and carry the byte bound. Repro: ~/.cache/gr8des/lane-k/gap-split/repro.ts.
- **Patterns held as data (G3, punted by the owner 2026-11-08):** a check that a value matches every pattern a closed
  relation lists for its key, e.g. one row per (domain, pattern), compiled into the CHECK as each key's patterns ANDed.
  It would delete qti-pie's product regex (~1.2 MB of install SQL for NCName). Until then qti-pie keeps it.
- **edullm's workarounds, for the owner (2026-11-08):**
  - `Query.bind` exists only on plain queries, so an Ordered with attachments cannot be a bound import; edullm ports
    pantry's document scan as a child under its own parent instead.
  - `Compute.cast` refuses an aggregate, so a count reaches natural through a bound sub-query under
    `Compute.nonnegative`.
  - `Db.open`'s own round trip: edullm asks that its checks travel in the first call's flight (owner deciding).
- **qti-pie's asks, for the owner:** ~/.cache/gr8des/integration/fallback-scan.md #2–#13, plus a counted family over
  a live derived relation, and Compute.matches over patterns held as data. #7 (row order for the regex cache) is
  performance machinery, ruled out.

### Next
- **PostgreSQL:** repin to 19rc2 when it is released on 2026-11-12 (pin.env, rebuild, re-init, delete the 19rc1
  build; RC2 includes the recursive-UNION hash_mem fix, so that patch goes; confirm DROP DATABASE … WITH (FORCE)
  beside parallel autovacuum and the RI fast path with a cast). Repin to 19 GA on 2026-11-19; the relcache patch is
  rebased and kept until a release includes it. Tell qti-pie first: its database lives in the cluster.
- **`bench:full` on a quiet machine.**
- **Test layout:** tests move into packages/*/test, with their mutate and fallow paths and the docs.
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
- upstream/fallow-unused-class-member-union-property: fallow credits no class member called through a property of a
  union-typed value, so .fallowrc.json keeps use and useRelation. File at fallow-rs/fallow, then drop the entries once
  repro.sh reports Cell.never alone.
