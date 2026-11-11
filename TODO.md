# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## After 1.0.0-beta.1

1.0.0-beta.1 is on npm (2026-11-08), tagged v1.0.0-beta.1 at 2e979b3c. Main carries the README rewrite and the
post-beta swarm's fixes for the next release.

### After the 1,000-children goal (the owner's pinned goal, 2026-11-10)
- **An exact repeat returns the row it met (delta.met, REACH's design):** a generated addition that meets a stored row
  at its arbiter key is a no-change whose delta.added is empty, so a double Start's loser learns its sitting's drawn id
  only through a read member. A third delta side, delta.met(R), holds the stored facts an insertion met as exact
  repeats: the arbiter becomes `ON CONFLICT (key) DO SELECT` with no WHERE, PostgreSQL 19's `RETURNING old.<key> IS
  NULL` marks an inserted row, and verdict rows are inserted, met equal or met differing (the conflict witness). It
  rewrites every insert's RETURNING, so it waits for the goal.
- **A SERIALIZABLE READ ONLY read beside a concurrent SERIALIZABLE import can still fail with 40001:** a certified
  READ COMMITTED role's reads stay SERIALIZABLE READ ONLY (one snapshot across their statements). SSI does not track
  READ COMMITTED writers, so such a read conflicts only with SERIALIZABLE writers, pantry's importWrite among them, in a
  dangerous structure among SERIALIZABLE transactions. Measure it under a live import once the goal ships.
- **A read-back keeps a per-call carrier where its delta crosses statements (CARRIER, 2026-11-10):** since CARRIER-01
  a read-back whose deltas one statement writes rides that statement's RETURNING, and two kinds still fill a temporary
  carrier on every call: a read-back over a delta two statements write (a relation written in two strata, or a put
  realized as a DELETE then an INSERT), the cost of rows crossing statements on stock PostgreSQL; and a read-back that
  joins a delta with state written at or after the delta's statement (the queue claim in bench/queue/claim.bench.ts,
  delta.added(Leased) with QueueWork). Neither downstream has one. CARRIER-01 numbers delta carriers after member
  carriers; no write the kit generates holds both.
- **startSitting's insert into Served replans under COMMIT (CARRIER, 2026-11-10):** the cause is not found. Finding it
  needs runs of ~/.cache/grizzle-release/CARRIER/m/replay.mjs.
- **Qti content is not provably sealed per import:** pantry mints node ids on the host (pantry/src/import/write.ts
  crypto.randomUUID), so the certifier cannot see that one importWrite call writes a test's content whole. edullm's
  learner writes read no Qti (the rotation is the app's computation, checked by native FKs), so the goal does not need
  it. A law enforcing the rotation inside a write would need database-drawn content ids or counted families under the
  document (a qti-pie change). The importer itself cannot be proved non-pivot either (the entry below), so learners
  reach content only through a publication layer.
- **strict(R), parked (REACH's design, cancelled 2026-11-10):** a declaration that every insertion into R creates its
  row, so an insertion at an arbiter key a stored row holds is that key's refusal, never absorbed as an exact repeat.
  The relation carries `RelationInfo.inserts: "repeatable" | "strict"`, with no DDL and nothing to migrate. The arbiter
  becomes `ON CONFLICT (key) DO SELECT` with no WHERE, and the inserted marker is `old.<key> = new.<key> IS NOT TRUE`
  (PostgreSQL 19's RETURNING old is null on a row the INSERT inserted), so every row it meets is a conflict. Ownership
  refuses it over a span primary key, whose exclusion constraint arbitrates by DO NOTHING alone, so no statement tells
  a row it met from one it made. It was cancelled because it cannot seal pantry's rule triggers, which read a row's
  siblings rather than its own key (NEGATION). The unfinished work is
  ~/.cache/grizzle-release/REACH/strict-cancelled.patch.
- **The QTI importer cannot be proved non-pivot:** pantry's overlays are flat rows, and 30 of its 31 rules read a row's
  siblings through shared node and package ids, which no seal the certifier holds covers, so pantry's importWrite
  stays a possible pivot of a dangerous structure (NEGATION, 2026-11-10). The only routes to a proof are nested overlays
  with a sibling seal (a qti-pie change) or closed groups. Until one lands, learners reach content only through a
  publication layer, never the importer's live rows.

### After the qti-pie and edullm repin (the owner, 2026-11-08: ship the repin first)
- **The beta.2 gate (owner, hard):** one full suite run (check, unit, types, PostgreSQL, deep) and `bench:full`, with
  every performance gate passing, both perfect on the exact commit; then the owner's go.
- **A sum over smallint or integer can wrap past its proved bound (SCALAR, 2026-11-10):** PostgreSQL 19's int4_sum adds
  without an overflow check (src/backend/utils/adt/numeric.c:6398), so scalar/aggregate.ts's typing of r.sum over
  smallint and integer as plain bigint, with rowDigits' proof that the sum stays below 10^(digits + 19), is false once
  the int8 accumulator wraps past 2^63: more than 2^32 rows of the largest integer wrap silently. A false proof; reach
  unverified.
- **A foreign key's selector re-types an authored typed literal at the column's typmod (SCALAR, 2026-11-10):**
  analysis/theory/laws.ts #selector, through irLiteral. Reach none (2026-11-11): it needs a selection conjunct `field =
  literal` whose literal carries its own type, which only Compute.literal gives; qti-pie's literals are all inside
  generated-field expressions and edullm's statements select nothing.
- **physical/serving's needed check can call a needed B-tree unneeded (GIST, 2026-11-10):** a generated span predicate
  binding a boolean whose name sorts first, with a range after it planned beside the GiST index it creates and nothing
  reordering that index, under a boolean loaded half and half: btree_gist splits the boolean cleanly, so the needed
  check would call the fix's B-tree unneeded. That is a false red of the suite, never a false claim of the engine. The
  Shift and Rota kept cases pin the mechanism with a skewed boolean.
- **Family removals statements scan a whole stored member table (ONERTT-WRITE2, with its removals fixes):** the
  defect the family owner's insert had (a stored relation read through a condition PostgreSQL cannot drive from the
  call's rows, so a sequential scan and a relation-level SIRead lock, a false 40001 between overlapping writers of one
  relation and a whole-table read per call). In write/family/removals.ts three statements read the member table
  `FROM <member> s WHERE <an OR of EXISTS over the call's rows>`, which no semi-join plans: the removed members
  (`removing`, a delete's key OR a put that moves the row out of its groups), the members a refill's ways reach
  (`reached`, an OR over the ways, each a chain of EXISTS from the root facts through the owners), and the rows both
  an edit and a refill reach (`holds(updated)` OR `holds(reached)`). Each should read its rows from the call's rows
  joined to the member by key or group, one arm per way or per kind of change, under UNION where arms may meet. No
  served write of qti-pie or edullm holds a family put or delete. Every other read of a stored relation in
  write/insert, write/put, write/delete and write/family/additions is driven from the call's rows by key or group.
- **Multi-schema follow-ups:** the guards, the planted bugs and every PostgreSQL suite's multi-level fixtures, landed
  after its first commit.
- **Stopped 2026-11-08 to focus on speed, resume before the full verification run:**
  - Tests cull: the deferred test-only exports (CompileReasonTag, TransientTag, queryValueDesc, continued,
    ReaderValue), real test-only code in production, fallow dupes in test/, @internal tags in tests, and the W6.Q10
    title.
  - The shell cull's RefreshReport and populatedSql (a statement per schema only tests read).
    Resume from ~/.cache/grizzle-release/CULL-SHELL/wip-e/e.patch (allowance and generated-1/2 runs left).
- **Waste hunt (remove work, never add machinery):**
  - Building qti-pie's Qti schema value costs about 36 s, a third of it grizzle's construction: ir/shape parse,
    schema/relation closedRows and admitClosedRelation, core/canonical, protocol rosterHandlesOf. The profile is
    ~/.cache/gr8des/prof/CPU.20261108.180041.75112.0.001.cpuprofile; Qti is the benchmark.
  - Rules over queries: commit time grows with the square of the rows written (8k rows × 5 tables ≈ 113 s against
    0.33 s with native foreign keys), though each probe alone is index lookups.
  - Pattern admission repeated in every lowering (REGEX2, 2026-11-09; held by main, generate-only once the served
    cutover lands). On the kit's layer at c83f33ac (loaded machine, CPU): the law model's batch admits each closed
    payload value read as a Compute.matches pattern, 370 calls for 365 distinct, about 260 ms (lower.ts admittedReads),
    and each literal pattern again, 202 calls for 89 distinct, about 60–100 ms (patternAdmissions), though only the
    refusal reads either. The cut: the lowering reads sources and admits none; one install-only pass in installBasis
    and generate's workload compile admits every pattern part the schema's expressions read (schema/walk.ts
    exprPatternReads, patternParts), refusing at the expression. It moves a term's refusal out of the lowering, which
    test/unit/compute/text.test.ts holds.
  - Pattern analysis carried on its values (REGEX2, 2026-11-09; held by main, generate-only after the cutover):
    Compute.when guards analyze x ∧ p again, 103 calls for 14 distinct, about 90–105 ms, and Compute.parse's lexical
    inclusion rebuilds the inner and form DFAs, 39 calls for 10 distinct, about 110–150 ms. The move: the pure regex
    engine (scalar/regex table, charset, ir, parse, nfa, partition, dfa, are, space, admit, source, inclusion's NFA
    core) becomes a zone `regex` importing only core, with TextBounds and ir/dag.ts postorder moved out of ir; ir,
    scalar, text and lower may import it; then RegexRef carries its members' IR and DFAs, the matches node its admitted
    Pattern, and the when guard its Pattern's analysis, outside identity and the canonical walk.
  - A generated CHECK's trial lowering (LAWS-BASIS, 2026-11-09; held by main). laws/model/model.ts #lowerCheck lowers
    each family and fold CHECK predicate into a throwaway DAG, then lowers it again for real: over its contract-typed
    leaves as they are where that typing admits it, else over their bases (baseLeaves), which changes the installed
    CHECK's text. On the kit's qti layer (author_app) at e2a0249a it runs 123 times and the trial refuses 8 (the 8
    stack captures), all `C(natural) = add(C(natural), 1)` from count and sum fold steps and a tree's start and end;
    the 14 other predicates with a compute node lower plain (concat over plain text, union over plain bits, greatest
    over natural, which keeps the contract). #lowerCheck is 29–46 profile-ms there, the trial about half.
    - **The exact fix:** a pure function in scalar/compute, beside the Lowering, giving the contract an operation's
      result carries over its operands' contracts: arithmetic none, greatest and least the common one, the set
      operations the first operand's, concat what concat() gives. The four Lowering sites (arithmetic, whose nominal is
      now the overload's plain result type; greatest/least, through commonType; union/intersection/difference, which
      return a.nominal; concat) derive their nominal's contract from it, carriers and bounds unchanged. RowConditions
      (laws/model/plan.ts) states plain or base as a typed fact on GeneratedCheck from it plus types.ts `meets`
      (already the one "a contract and its bare base never meet"), so #lowerCheck lowers once in the chosen form, with no
      trial and no throwaway DAG. A unit search over add, union, greatest and concat with contract or base operand types
      asserts the fact matches the Lowering's verdict (Qti reaches no union or concat over a contract), and a plant
      flipping the function's result for one operation must fail both the search and the dump.
    - **Cost:** 2–3 h; lower.ts is shared, so coordinate with whoever is editing it; the proof is the whole suite plus
      both kit dumps byte-identical (the same 8 base, the same 115 plain), since the four sites serve every compile
      mode (queries, row checks, generated fields, contract predicates, folds).
    - **Gain:** 10–20 ms of CPU on author_app's layer; 0 on the Ledger, whose slice plans no generated CHECK.
    - **Ruled out:** a second copy of the rule in plan.ts; skipping the lowering at the layer, since the witness judges
      a CHECK by its lowered predicate on the host (write/program/witness.ts checkOf, write/family/fold.ts
      hostEvaluator) and lawPatterns reads its lowered matches; lowering plain into the extension DAG and base only
      on refusal, a try-then-alternative that leaves unreachable nodes and moves DAG labels.
  - scheduleStratum's pairwise reference scans (WORKLOAD, 2026-11-09; held until ONERTT-WRITE2's C4 lands, since C4
    edits write/frontend/schedule.ts). On the kit's qti layer (author_app), pantry importWrite's one stratum, one call
    per loginRoles, has 157 actions, 241 family statements and 80 immediate references. scheduleStratum tests every
    ordered pair of plain actions on different relations with a references.some (about 2.0M closure calls, almost all
    false), and scans every reference for each action and family statement pair (about 3.0M), though an edge exists
    only between two relations a reference joins.
    - **What it deletes:** both scans. Group the actions by relation and the references by (from, to) once, then walk
      the references and join their relation groups, and look up an action and statement pair's references by its two
      relations. Smaller, in the same cut: statements keyed by (relation, step) instead of a statements.find per
      rowsOf, statementOf and nodeOf; a ready count per vertex instead of remaining.find with every and filter per
      placement (398 vertices); dependsOn without an ordered.slice per action.
    - **Byte-identical:** follows is a Set whose order no reader takes (the topological pick tests membership,
      cycleAmong walks remaining's order, dependsOn uses has), so equal edge sets give the same schedule and the same
      refusal text.
    - **Notes:** ~/.cache/grizzle-release/WORKLOAD/scratch/sched-analysis.txt.
- **A key over exactly the primary key's fields states the primary key's law, plain as span:** the draft and migration
  probe are in ~/.cache/grizzle-release/LAWSTMT/step2. It still needs its PostgreSQL run and a migration guard for a
  foreign key into the dropped redundant span UNIQUE.
- **Keys over one field set, after DUPINDEX-01:** a key stated over a view whose fields map onto exactly a declared
  key's set merges into that key (laws/model/model.ts nativeIdentity), but ownership (schema/own.ts distinctKeys) does
  not refuse it as it refuses two declared keys over one set. analysis/theory/laws.ts keyedWithin and
  analysis/isolation/certify.ts sameKey keep field-set comparisons of their own instead of KeyColumnSet.
- **The types and the engine part on family members (COMPUTE, 2026-11-10):** `select(R, w => w.and())` as a family
  member is refused by the types and admitted by the engine, which reads the empty conjunction as the relation (it
  predates COMPUTE-02, found by reading); a tree over a selection may print the tree's refusal beside the member
  refusal, since types/schema/statements.ts SideShowsKeyed reads no selection. A primary key over a set is still refused
  as UnrepresentableKey.
- **One statement per write stratum (waste):** the write executor keeps carriers (a TEMPORARY table per write) and the
  sequential realization, with UnorderableStratum refusing what it cannot order. Making every stratum one statement
  (sibling data-modifying CTEs reading the stratum's state) deletes both, but rewrites the insert, put, delete, serial
  and entry protocols (4-5k lines). Deferred 2026-11-08 behind ONERTT-WRITE's one-flight family writer (F2).
- **Patterns held as data (G3, punted by the owner 2026-11-08):** a check that a value matches every pattern a closed
  relation lists for its key, e.g. one row per (domain, pattern), compiled into the CHECK as each key's patterns ANDed.
  It would delete qti-pie's product regex (~1.2 MB of install SQL for NCName). Until then qti-pie keeps it.
- **grizzle admits regex patterns PostgreSQL compiles slowly (DIETR, REGEXREACH, 2026-11-10):** nullable bodies under
  counted repetition take PostgreSQL up to 24 s to compile (`(?:(?:(?:a|)){16,}){50}b` took 19 s), and a domain CHECK
  holding one costs each new backend that long on its first use. Unreachable in qti-pie and edullm: none of their 463
  distinct patterns has that shape, and each compiles cold in at most 26 ms. What grizzle admits stays the open
  question.
- **edullm's workarounds, for the owner (2026-11-08):**
  - `Query.bind` exists only on plain queries, so an Ordered with attachments cannot be a bound import; edullm ports
    pantry's document scan as a child under its own parent instead.
  - `Compute.cast` refuses an aggregate, so a count reaches natural through a bound sub-query under
    `Compute.nonnegative`.
  - `Db.open`'s own round trip: edullm asks that its checks travel in the first call's flight (owner deciding).
- **qti-pie's asks, for the owner:** ~/.cache/gr8des/integration/fallback-scan.md #2–#13, and Compute.matches over
  patterns held as data. #7 (row order for the regex cache) is performance machinery, ruled out.

### qti-pie's after-pin queue (qti-pie's sweep, relayed by edullm-30 2026-11-09)
In qti-pie's priority order, each with its lane and a stable label (a closed item is deleted, the others keep theirs);
each deletes code pantry or edullm keeps today. It lands after the owner's post-pin order (the staged-imports SSI fix,
the compute test fix, the held fill-order, multi-hop and GiST fixes, LOADER's served matchers and admitted literals),
Q1 to Q6 first. A new feature still needs its correctness need named in its commit.
- **Q1.** A Db that holds only `workload`: db.get, execute, page, compile, apply, refresh and explain deleted (CULL,
  with LOADER's share of the deletion split).
- **Q2.** The rowless ChangeSet builder (CULL, its builder series).
- **Q3.** A law's id exported from the schema, and lawKeyOf, so pantry drops its committed LawId dictionary; RefusedLaw
  names no QTI law-table today (ARTIFACTS2).
- **Q4.** The quadratic commit cost of rules over queries (NEGATION).
- **Q5.** The cost of compiling the law model and building the Qti value (WORKLOAD2).
- **Q7.** A Compute text split (SHA256). No substring, split_part or pattern group exists, so pantry splits on the host
  and writes the pieces as rows (IDREF, header and tolerance tokens, identifier leads and trails, href pieces, reading
  segments, unordered pairs). It must be total under a matches guard, IMMUTABLE, and carry the byte bound. Repro:
  ~/.cache/gr8des/lane-k/gap-split/repro.ts.
- **Q8.** Patterns as data: REGEX2's served matchers (LOADER, its (a)).
- **Q9.** regexMaxRepeat exported (LOADER).
- **Q10.** An installation map, and a ChangeSet host preview (FORMAT).
- **Q11.** Folds stepped by a closed relation (ONERTT-WRITE2).
- **Q12.** An opt-in role namespace, grizzle#10 (GENERATE).
- **Q13.** A generated term over a drawn field (SHA256).
- **Q14.** Type checking of a rule's nested sources (NEGATION). A derived relation a rule's side reads whose definition
  matches or negates a query or derived relation that aggregates, orders and takes, attaches, approximates or recurses,
  or negates one that negates in turn, type-checks and is refused only at runtime, UnsupportedLawFamily from
  analysis/theory/query.ts's Flattener, because RuleRead (types/derived/derived.ts RuleReadOf) reads the definition's
  own arms and never what they match or negate. The fix: r.match and r.not record in the rule's facts the refusals of
  the source they read (a derived relation's own RuleRead, a query value's arms' refusals, and for r.not whether those
  arms negate, which UnionArm would then carry), find carries their union into the arm it makes, and ArmRefusal adds
  them with the engine's words, linear in the matches and filters; then the schema agreement's derivedProbe draws a
  matched and a negated query that aggregates, and one that negates in turn, as faults.
- **Q15.** A stream over an ordered query (PORT-Q1), waiting on the owner: every page in one snapshot transaction is n+1
  round trips, the shape db.snapshot was deleted for, and a page per transaction gives no snapshot; built in neither
  form until the owner rules.
- **Q16.** A family whose member side is a selection (ONERTT-WRITE2).
- **Q18.** A counted family over a derived relation: a family reads stored tables only, which keeps pantry's isNcName
  name rows (D27/D29) out of the database (CHUNK).
- **Q19.** collapse of an unbounded text inside a query, refused today without a length bound; it also blocks D27/D29
  (PORT-Q1).
- **Q20.** A family that groups by a generated field: a family's group key is caller fields today, which keeps 3 of
  pantry's 13 copies host-written (CHUNK).

### Next
- **Reads forward PostgreSQL's bytes (WIREPASS, the owner, 2026-11-11):** the live wire decodes PostgreSQL's JSON
  (attachments are aggregated as JSON in the served statement, lower/shapes/attach) into host values, then re-encodes
  them in carrierWire's spellings (live/wire.ts): int8, numeric and money as strings, bytes as base64. That is a
  decode/encode cycle per row on every read. Have the served statement build the wire's spellings itself (int8 cast to
  text inside the JSON build, and so on per carrier), so the server forwards PostgreSQL's bytes into the SSE data line
  untouched. The live diff compares rows, which works on bytes only if spelling is canonical both ways: carrierWire
  already guarantees one value per spelling, and it must add one spelling per value (float specials, -0, numeric
  trailing zeros, date and span forms). Think it through and fix it once live works; the oracle is byte equality with
  today's encode over every carrier.
- **PostgreSQL:** repin to 19rc2 when it is released on 2026-11-12 (pin.env, rebuild, re-init, delete the 19rc1
  build; RC2 includes the recursive-UNION hash_mem fix, so that patch goes; confirm DROP DATABASE … WITH (FORCE)
  beside parallel autovacuum and the RI fast path with a cast). Repin to 19 GA on 2026-11-19; the relcache patch is
  rebased and kept until a release includes it. Tell qti-pie first: its database lives in the cluster.
- **`bench:full` on a quiet machine.**
- **Test layout:** tests move into packages/*/test, with their mutate and fallow paths and the docs.
- **RDS IAM** against a real RDS.
- **The worlds' page:anchored feature (WCOVER, 2026-11-10):** WCOVER-01 compares anchored pages but requires no feature
  that reaches one. With page:anchored required, isolation reads at TEST_SEED=3971498375 held a led case past its hang
  limit: both reads leads take every required feature, and a pending one keeps directTransaction's afterBegin
  look-ahead (test/support/worlds/drive/suite.ts) running. Require it again once the reads leads stop looking ahead at
  features a direct transaction can't reach. The cause is read from the code; no run confirmed it.
- **Cross-repo, outside school hours for edullm:** grizzle's packages/testing differs from superstarter's in 43 files.
  Reconcile them, then copy the library into edullm with the shared lint standard.
- **pg/fin/fold-ends' lone-writer 40001 is PostgreSQL's summarized conflict-out path
  (upstream/ssi-summarized-conflict-out):** CheckForSerializableConflictOut tests no concurrency before pg_serial, so
  under a cluster-wide pinned xmin and a full SSI pool any SERIALIZABLE call that scans dead versions can fail with no
  writer beside it. The patch is proven (its isolation spec fails unpatched and passes patched; src/test/isolation and
  src/test/regress pass) and waits for the owner, low priority: production (AWS) runs stock PostgreSQL. Once the pin
  carries it (FOLDENDS-02), cut the worlds model's lone-session 40001 and README's "even with no other transaction in
  sight".
  The same path failed e2e-platform/reads' one refresh under the candidate batch's load ("old pivot" and "pivot, during
  write" reason codes, no prepared transaction, no slot); its caller now runs a call again after a TransientFailure,
  as the platform races do (SSIDIAG-03). It also makes coverage verdicts depend on load: pg/world-model/deletion
  (deletion:derived-refreshed, TEST_SEED=4164111326 on c0648dda) and pg/world-model/errors
  (op:open-db:inside:matching:db:open-refused, TEST_SEED=4244721848 on 357133b6) spent every steered case without
  reaching a feature they reach alone at the same seed, because a Db apply that commits alone came back transient
  under load and changed which seeds the steered phase mutates. Fix the representation so a witness's notes cannot
  depend on a transient the environment decides.
- **Refilling a tree's values in the flight (the owner, 2026-11-09: refused for now, built later):** a change that
  reaches a stored tree's values (a node's copy of its parent's, a sibling's predecessor copy or fold, a parent's ends
  or last copy) is refused when it compiles (StaleDerivedRead, cause `tree`; write/frontend/refill.ts stratumRefill).
  The designed form, in the stratum's removals statement (write/family/removals.ts): a WITH RECURSIVE walk from each
  changed tree's root down, one tree level per iteration, each iteration redrawing the children of the previous
  level's nodes as one group with the redraw scans the removals statement already builds for an ordered or counted
  group (write/family/scan.ts), the parent's copies read from the previous level's rows, carried in each row for its
  siblings, and the siblings' predecessor copies and folds stepped within the level; then one pass grouping the walk's
  rows by parent for each parent's ends and last copies; then one UPDATE of every node whose values change. No node
  moves, so slots, counts and intervals stay. Estimated at 500 to 900 lines with a tree variant of the scan. The
  families swarm's tree kept case and fill.ts writesVerdict's `tree` arm turn back into refills when it lands.
- **Refilling what a refill itself changes, in the flight (the owner, 2026-11-09: refused for now, built later):** a value
  that reads what a refill itself changes (an owner's end or last copy, a member's predecessor copy or fold plane) is
  refused when it compiles (StaleDerivedRead, cause `chained`; write/frontend/refill.ts stratumRefill). The sized design,
  in write/family/removals.ts and write/frontend/refill.ts, three parts: (1) riders of riders, the removals statement's
  two rider levels (the edited members, then those riding their redraws) generalized to the refill closure's order,
  each redrawn family's scan the next level's root rows, about 150 lines; (2) a redraw order within one relation, so a
  family whose fold steps a plane another family of the same relation redraws scans that redraw's output, not the
  stored rows, about 150 lines; (3) riders rooted at the removals statement's own recount, an owner's ends and last
  copies as it writes them, read by the owner's own families or carried into another family's members, like the
  additions statement's recount roots, about 200 lines. 400 to 800 lines in all, no recursion: the closure holds no
  cycle. fill.ts writesVerdict's `chained` arm turns back into refills when it lands.
- **Refilling what a family member's own write reaches, in the flight (the owner, 2026-11-09: refused for now, built
  later):** a value a member relation's put, delete or append reaches beyond the two the flight refills (a re-placed
  owner's members' copies, and its own family's members' copy of an append's recount) is refused when it compiles
  (StaleDerivedRead, cause `edit`; write/frontend/refill.ts memberWay). The sized design: (1) generalized edit riders,
  an edit's root rows its own put-updated rows for a change of its caller fields and its redraw scan for a redrawn index
  or copy, carried along a chain of owner axes (removals.ts cascaded's hops) to a fold, predecessor or last copy, about
  150 to 250 lines in write/family/removals.ts, write/frontend/refill.ts and the schedule's rider effects; (2)
  recount-rooted riders, the additions statement's recount (450d0984) and the removals statement's own recount feeding
  rider members updated in the same statement, about 200 to 300 lines. They are the chained refills' parts (1) and (3)
  (the entry above): whoever builds one builds both together, which leaves only the chained part (2), a redraw order
  within one relation, apart. fill.ts writesVerdict's `edit` arm turns back into refills when they land.
- **FamilyStep outlives the served port (PATTERNS):** the served artifact's step type still holds FamilyStep
  (runtime/write/steps.ts), which only the legacy planner builds: runtime/write/bind.ts servedFlights throws a defect on
  it, and bench/write/support/writes.ts FamilyLabel and bench/queue/support/queue.ts's `family` case mirror it.
  Deleting write/program/bind.ts legacyFlights, once the refills above move into the one flight, deletes FamilyStep, the
  throw and both bench mirrors; no type split before that.
- **Query oracle remainder (CULLQ):** the approved codemod deleting RunOptions' dead "fresh" kind and defaultRunOptions
  (test/support/oracle/runner.ts) and its callers' spreads, after CULLR's runSides primitive (one install, several
  judged sides), which is not on main; pipelining captureRows' describe and capture pair (oracle/install/capture.ts) and
  explainStatements' round trip per statement.
- **Write oracle and fin remainder (CULLW):** the tree suite's JavaScript profiling (its P4) is not started; the
  rewrites suite's small box may not reach "a case ended by COMMIT" (decide its sampled end after it runs).
- **Unit and type tier remainder (CULLU):**
  - Growth gates read a bare `const linear = 2.5`: read the n/2n/4n increment ratio instead in test/unit/startup/work,
    startup/guarded-keys (two gates), analysis/logical/join-cost, laws/scaling, program/size and
    lower/conservative/sharing, and likewise packages/testing's oracle.test set-comparison cost bound (8·n·log n).
  - Hand verdicts through element(...) inside generators: unit/lower/feedback (count its blocks and scans by an
    independent walk, depths int(1, 5) for element([1, 4, 5])) and unit/analysis/logical/logical (hold it to universe
    truth, option a); unit/analysis/theory/families keeps a fixed tree branch.
  - Fold unit/page/compile's bounded heterogeneous union refusal into unit/page/total and delete the file.
  - Slim: types/evidence/agreement (reorderedVerdicts re-derives notes; floor witnesses recomputed),
    lower/rewrite/universe, analysis/small/claims (a second Reference) and logical/evidence (logicalUnsound re-checks
    key proofs per input), types/schema/budget/families (armed and disarmed both run full checks). Not profiled yet:
    types/schema/budget/scaling, types/query/budget/scaling, packages/testing/consumer.
- **World-model, education, tree, page and derived suites (CULLWM), each a proposal, built only on the owner's go:**
  - Delete test/pg/substrate/tree.test.ts's five boxes, which duplicate fin/tree's generators and oracle (fin uses
    substrate's predicted), keeping tree.ts's model and generators; delete ddlOf when fallow flags it; carry "T3 without
    its check" and "without T6" into fin/tree as first-child and interval mutants; the fallback is judging by
    attemptChecked.
  - checkState opens a superuser connection per world-model step (test/support/substrate/substrate.ts
    asSuperuserRead): hold one read connection per realization, its reads pipelined.
  - The allowance suite installs one of at most 31 schemas about 375 times: an explicit roster, one install per
    distinct subset, a per-case reload and its views reset WITH NO DATA. The same for the README-shaped world-model
    suites: realize once per file as education does, the roster worlds under ordinarySession.
  - A cull candidate: test/pg/page/generated.ts's statement-count assert and its probe-presence assert.
  - Open, the owner's call: page/generated's required feature "a traversal of at least 200 pages in one direction"
    (longTraversal) has no named source.
- **KEYLAW's remainder:** the positive path, a 42Z01 classified as outside-world for an entry the role writes through
  (adapter/witness/classify.ts ReportedNames), has no unit-level oracle, since no test installation writes through a
  query entry; the MemberAt and ArrayMember relation stays the caller's string spelling at the input boundary.
- **A stratum that deletes a serial relation's facts, inserts into it and adds facts that reference it is refused as
  UnorderableStratum whatever its rows (KEYLAW, 2026-11-11):** laws/the-law-family-box/immutable at
  TEST_SEED=1113653230, write/oracle-3 at TEST_SEED=1069369552. An insert drafts a generated class beside the complete
  one; the deletion excepts only complete additions, so it must precede the generated class, which precedes the
  referencing additions, which precede the deletion. Fix: the deletion excepts the stratum's drawn facts too (the
  generated insert's RETURNING into the stratum's carrier), so a deletion of a relation whose facts meet nowhere orders
  nothing against any addition. Unreachable today: no served file holds a delete or a put.
- **The substrate's lease waiters hold a snapshot while blocked (SSIDIAG, 2026-11-11):** takeLease waits in
  `SELECT pg_advisory_lock` (test/support/substrate/shared.ts:148-151), pinning the cluster's vacuum horizon for up to
  115 s under load (read committed: vacuum's horizon, not SSI's). The fix is a hard cutover to a snapshot-free
  LOCK-based lease (a table per slot locked IN EXCLUSIVE MODE by an open transaction, NOWAIT first; holder and waiter
  show backend_xmin and backend_xid NULL; ACCESS EXCLUSIVE would assign an xid), done when no lane runs an old tree.
  Parked: ~/.cache/grizzle-release/SSIDIAG/SSIDIAG-04.parked.patch.

### Parked by the scope lock (the owner, 2026-11-10)
- **UPSTREAM:** an audit of every upstream/ and scripts/pg/patches patch to maintainer quality (the owner's order,
  2026-11-10).
- **The test-diet queue's files no cull lane took:** test/pg/adapter/flight and the smoke and check scripts.
- **QSET, canonical query IR sets:** the draft is ~/.cache/grizzle-release/QSET/draft (admission.ts's canonical walk,
  ir/open.ts, a partial build/rule.ts, oracle tests, qset-01-wip-types-on-setfp-grizzle2.patch over
  setfp-grizzle2-base-for-wip.patch). Open point: the decoder door cannot canonicalize at exprDescShape (neither door
  reorders contract or generated expressions), so imports need bottom-up Canonical<QueryDesc> admission with a second
  expression family for non-query positions. The builder, the checker over Named and the attach-stage consumers are
  unwritten.
- **SETFP, the rest of qti-pie D1's class:** the fingerprint still depends on order in str.and's arguments
  (text/field.ts keeps them in order into FieldDesc.patterns), a contained statement's term pairs (schema/own.ts
  canonicalSide canonicalizes the selection, never the terms) and and/or/IN nested under cond, when, cast or compute
  (QSET's walk). Hardening only: SchemaDesc relations and statements, contract facts, closed slots, login roles, field
  records (a built description creates columns in declared order, a decoded one in name order, under one fingerprint),
  a decoded description's alternatives arms (the builder already keeps roster order) and role entry lists (nothing
  digests RoleDesc list order). Parked in ~/.cache/grizzle-release/SETFP: parked-sweep-over-874e7b05.patch (typecheck
  clean, ungated; it holds CanonicalText and other QSET imports), parked-fields-wip-over-eb56d58b.patch and
  parked-fields-wip-set.ts.
- **INDUCTIVE-02, Aiming.read as data across suites:** the draft is ~/.cache/grizzle-release/INDUCTIVE/draft-02
  (weights.ts Reading = own | calls, action.ts's reachedBy interpreter; suite.ts's blocks unapplied;
  education/support.ts and compile.test.ts edits unwritten), untypechecked.
- **SHRINK-02:** the testing library's items primitive, with open and close deleted.
- **SCALAR-03:** a computed-numeric SQL tag in the types, so the TypeScript types refuse a computed numeric written into
  a plain numeric field as compilation does.
- **COMPUTE-03:** the compute, changeset and query agreements still pair the engine's prose by prefix, and the checker's
  binding sites still state prose ("a column the selected arms lack", "constants no arm delivers"); the agreements by
  roster.
- **CLAIMS-03, the read-once face:** parked at ~/.cache/grizzle-release/CLAIMS/parked-CLAIMS-03.patch. Fifteen other
  Cause.pretty renderers print a bare error name with no data: test/unit/adapter/layer.test.ts (three),
  test/unit/adapter/flight-bound.test.ts, test/pg/oracle/public/run.ts (three), test/pg/reads/boundary.test.ts,
  test/pg/substrate/stopped.test.ts, test/pg/migrate/support.ts, bench/harness/runner.ts (four) and
  packages/grizzle/src/cli/run.ts's internal error.
- **REDTESTS-04, grizzleActor through the approved recordingDriver:** grizzleActor learns a Db session's backend from a
  recording driver (BackendKeyData), per layer build. Parked at
  ~/.cache/grizzle-release/REDTESTS/parked/REDTESTS-04.patch (with its .msg), applying over 4dfbdba9 with REDTESTS-01 to 03, typechecked only. It owes the lint gate, payroll,
  queue, derived/refreshers, races-alternatives and its plant (a recorder recording the first session twice fails
  payroll at its actor).
- **DERIVEDWRITE, a write whose rows derive in its own statement (edullm, 2026-11-11):** a ChangeSet insert's source is
  given rows (`r.relation` inputs) or a rule over stored relations, with no aggregate, arithmetic or ranking term, so a
  write that computes its rows from state reads them first. edullm's Start reads `latestAttempt` (the child's greatest
  attempt at the test) and `testPools` (pools in start order with their variants), computes attempt = greatest + 1 (0
  with none) and each pool's variant at `attempt mod count(variants)` on the host, then inserts Sitting and Served:
  three round trips, about 120 ms server-side (one statement estimated at 40–50 ms, unmeasured). The design:
  - **Source terms:** an aggregate over a correlated match with an empty-match default (`coalesce(max(attempt) + 1,
    0)`; the same term gives edullm item 7's count that is 0 on no match), integer `+` and `mod`, and an ordinal within
    a group under an order (`row_number() OVER (PARTITION BY pool ORDER BY start)`), compiled into one `INSERT …
    SELECT` per stratum.
  - **The certificate:** the derived key (attempt) reads the relation the write inserts into (Sitting by child and
    test), so two concurrent calls derive the same key and the key arbiter absorbs the second as an exact repeat
    (today's no-change semantics). The certificate states that read as an aggregated read of the written relation and
    either proves READ COMMITTED safe through the arbiter or names it as a reason that lowers the role.
  - **The read-back:** the write returns the row it met (delta.met, the 1,000-children goal's entry), so a double
    Start's loser lands on the winner's sitting with no read member.
  - **Depends on** delta.met. Distinct from the refills refused 2026-11-09, which refill derived values inside a flight;
    this derives a write's own source rows.
  - **When it lands,** edullm deletes Start's two reads (app.ts) and its host rotation `planOf` (sittings.ts), and Start
    becomes one apply. Without it, edullm can cache a published test's pools per instance (published content is
    write-once until a wipe, which mints new ids), removing one of the three round trips.
  - **Parked** until the owner's go and a measurement of Start after that cache.

## Upstream, for the owner to file
- upstream/node: TextEncoder.encodeInto underfills an exactly sized destination for text holding U+0400 to U+07FF
  (nodejs/node#65994, fixed by #65997, unreleased). Once a Node release carries #65997 (repro.sh prints PASS on every
  line), restore encodeInto in packages/engine/src/codec/bytea.ts textArray, whose encode() per element is the interim
  and allocates per row, with test/unit/codec/text-array.test.ts and test/pg/write/text-arrays as its guards, and
  delete the folder.
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
- upstream/arkregex-zero-width-space-marker: ArkRegex reads a literal U+200B in a pattern as its own error or anchor
  marker, so grizzle's scan writes it as NUL and the host type writes it back (types/fields/source.ts, regex.ts). File
  at arktypeio/arktype, then delete the stand-in once repro.sh reports the control alone.
- grizzle/upstream/fallow: fallow reports class members read through a Map of the class as unused once the class
  implements an interface: FamilyEntry.folds, fold and axes (analysis/theory/families.ts), which the Normalizer reads
  through its Map of FamilyEntry (analysis/theory/laws.ts), since c665a759; dropping the implements clause alone does
  not clear it. Patch it in grizzle/upstream/fallow, then delete .fallowrc.json's usedClassMembers entry scoped to the
  class that implements RiddenFamily.
