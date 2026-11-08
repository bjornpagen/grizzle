# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## Now: the first publish, 1.0.0-beta.1

Owner 2026-11-07: the final batch has landed and the scope is frozen. Only a real correctness bug comes back to the
owner first. Passing tests are not required to publish. Every agent commits straight to main, with no commit gate.

### The publish
- **Main's release pass:** typecheck and `pnpm check` clean, fixed by hand; schemas.ts `sourceTermValue` (from
  6a733b71); edit.ts's dead `familyColumnType(...) ?? plane.end.type` fallback; superlint's limit-evidence findings in
  codec/bytea.ts.
- **Versions** to 1.0.0-beta.1 in packages/engine and packages/grizzle. The license is 0BSD (owner, 2026-11-07).
- **Tarballs:** `git archive` the release commit into ~/.cache/grizzle-release/, `pnpm install --frozen-lockfile
  --ignore-scripts`, then `pnpm pack` packages/engine and packages/grizzle twice and compare byte for byte; a scratch
  consumer installs from them and imports. The release commit's full hash goes to the owner.
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
- **qti-pie's other limits:** #8 float cast totality past the double form.
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
- **Exports qti-pie asked for after the freeze:**
  - `insertableNamesOf(schema)` / `InsertableNameOf<S>`: the relations a ChangeSet inserts at top level (writable and
    no family's member), plus insertAll's record type. Today pantry casts.
  - `patternLawsOf(schema)`: the per-field pattern laws, beside lawsOf. A tautology pattern states no law, and pantry
    can't see that today.
- **role's write list naming a relation twice** (`{ write: ["A", "A"] }`) is admitted by the types and refused by the
  engine as writeTwice (found by FULLROLE).
- **Failing at HEAD on 2026-11-07, none on a qti-pie path:**
  - test/types/schema/agreement.test.ts: about 15 cases where the types miss the "the sides' field types differ"
    refusal, and derivedMirrors is never reached;
  - test/unit/compute/aggregate.test.ts: no registry node for singleton;
  - test/unit/compute/text.test.ts: "a literal's ARE", plus one text-matches case seen once ("each value the pattern
    can take, once");
  - test/pg/world-model/execute.test.ts leak scan: a direct 23505 on Doc's primary key (TEST_SEED=635540385);
  - test/pg/world-model/laws.test.ts: `invalid:fact:filtered-serial-omitted` is never reached.
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
  - qti-pie, 2026-11-07: nothing it stores today comes near the bound (largest 64 MiB). But QTI sets no file size
    limit, so a lawful package with a video over about 256 MiB is refused at import. First in line after beta.1.
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
