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
- **Waste hunt (remove work, never add machinery):**
  - Building qti-pie's Qti schema value costs about 36 s, a third of it grizzle's construction: ir/shape parse,
    schema/relation closedRows and admitClosedRelation, core/canonical, protocol rosterHandlesOf. The profile is
    ~/.cache/gr8des/prof/CPU.20261108.180041.75112.0.001.cpuprofile; Qti is the benchmark.
  - Rules over queries: commit time grows with the square of the rows written (8k rows × 5 tables ≈ 113 s against
    0.33 s with native foreign keys), though each probe alone is index lookups.
- **A key over exactly the primary key's fields states the primary key's law, plain as span:** the draft and migration
  probe are in ~/.cache/grizzle-release/LAWSTMT/step2. It still needs its PostgreSQL run and a migration guard for a
  foreign key into the dropped redundant span UNIQUE.
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
