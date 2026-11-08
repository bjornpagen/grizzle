# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## After 1.0.0-beta.1

1.0.0-beta.1 is on npm (2026-11-08), tagged v1.0.0-beta.1 at 2e979b3c. Main carries the README rewrite and the
post-beta swarm's fixes for the next release.

### Next
- **A containment whose source is a semijoin, `within(...)`** (JOIN, deferred by the owner 2026-11-07). qti-pie keeps
  copy fields for it (unwrittenType, the metadata `named` copies, HeldType's existence).
  - Why it waits: no PostgreSQL constraint over R, S and T can state "every R row with a matching S row is in T". Two
    lawful states, {r} and {s}, combine into an unlawful one that every single-table constraint and every null-guarded
    foreign key still admits.
  - The two ways, for the owner to choose between:
    - T: one deferred constraint trigger per law, checking at COMMIT. It reverses README's "never a trigger" (lines
      107, 918, 1611).
    - N: a parent relation keyed by the join value, with hidden flag columns the writer fills. That means thousands of
      lines in the write planner, and new write restrictions.
  - The design, if T: `within(on(R, f…), on(S, g…))` read only as `contained`'s source, with
    SourceSideDesc.within: WithinDesc[].
    - The trigger function is SECURITY DEFINER, with EXECUTE revoked from PUBLIC.
    - R, S and T events probe by their own keys.
    - A violation raises 23503 naming the law's constraint, with no DETAIL.
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
