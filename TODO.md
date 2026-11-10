# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## After 1.0.0-beta.1

1.0.0-beta.1 is on npm (2026-11-08), tagged v1.0.0-beta.1 at 2e979b3c. Main carries the README rewrite and the
post-beta swarm's fixes for the next release.

### After the qti-pie and edullm repin (the owner, 2026-11-08: ship the repin first)
- **The beta.2 gate (owner, hard):** one full suite run (check, unit, types, PostgreSQL, deep) and `bench:full`, with
  every performance gate passing, both perfect on the exact commit; then the owner's go.
- **Known red tests, real defects no served write of qti-pie or edullm reaches (the owner, 2026-11-09: fixed after the
  repin, the tests left red until then; neither served file holds a removals statement):**
  - test/pg/write/fill-order/fill-order.test.ts, TEST_SEED=252072110, the rotating stream (seed 0xb7f6fa7a), case 2:
    a lawful delete is invariant-rejected. The minimal shape: a member relation in an ordered family and in a counted
    family, each of a mutable owner, the counted family's owner axis immediate; a delete (or a re-placing put) of a
    member re-places a later member of its ordered group whose counted group the same statement recounts. PostgreSQL
    refuses the stratum's family removals statement with 23503 on the counted family's owner axis
    (`__r_2_fk_o_1_copy_n_1`, Key (o_1, ‹n1›)=(the owner, 2) not present in r_1). The cause, in
    write/family/removals.ts: the re-placed row is inserted again with the counted family's stored count copy (the
    scan copies `groups.stored` for a counted family, and a row below its least changed slot keeps its own), while the
    statement's recount of the owner changes the count; the insert's foreign-key check runs before the recount's
    cascade reaches it. A sequence's own copy is the kept count where its group is recounted here, so it escapes. The
    fix, held by ONERTT-WRITE2: a re-inserted row copies each counted family's kept count where the statement recounts
    its group.
  - test/pg/write/swarm/families.test.ts, its kept case "a put of an owner whose v two owner axes carry, into an
    ordered family's members' copies and on into a counted family's members' copies, which its sum fold steps": the
    follow-up's put of the owner is invariant-rejected. The shape: R0 owns an ordered family of R1, whose members copy
    R0's `v`; R1 owns a counted family of R2, whose members copy R1's copy and sum it; a put of R0 refills R2's fold
    along both owner axes, the multi-hop way of 8df4c050 in the call's one flight. PostgreSQL refuses the removals
    statement's refill with 23514 on R2's sum-fold CHECK (`__r_2_check_r_1_n_1_sum_fold`): the refilled row's family
    columns are index 1, ‹n› 0, before 1, after 0, where the reference has 0, 1, 0, 5. The cause is in
    write/family/removals.ts cascaded or its merge into the redraw, still to find; the fix is held by ONERTT-WRITE2.
  - test/pg/physical/serving.test.ts, "every request a generated workload plans is served, and every index it creates
    is needed", TEST_SEED=252072110, the rotating stream (seed 0xa1036de9), case 6: a B-tree range request is planned on
    a GiST index that reads three times its result. The shape: a relation with a GiST index on (a closed handle, a
    numeric of many values, a handle, a span), created for a span probe, and a workload range on (the handle by
    equality, the numeric by a range). The engine plans the range on that GiST index (physical/indexes/engine.ts
    rangePlacements, whose btreeMethods admits GiST for scalar keys), and PostgreSQL's probe, `jsonb_pretty = '1' AND
    fixed_0 BETWEEN '0.00' AND '0.70'`, reads 92 buffers of the GiST index's 184 for 3,334 of its 20,000 entries,
    over the 38 the result's share bounds: GiST places entries by its first column of many values (gistchoose,
    gistSplitByKey), here the range's own column, so the few-valued equality prefix narrows nothing and the scan reads
    the range across every handle. The engine's own GiST rule states this for GiST requests; its range rule does not.
    The fix: a GiST index serves an equality-prefix range only when the prefix is empty or holds a column of many
    values, so a B-tree is created for a prefix of few-valued columns alone. Neither qti-pie's install nor edullm's
    holds a GiST index, and edullm's one range (Section(start)) has no prefix. The fix is held by GENERATE.
  - test/pg/world-model/rules.test.ts, TEST_SEED=665578811, the steered phase (seed 0x48e8b3db), case 14, replay
    TEST_REPLAY='pg/world-model/rules:72322:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.1.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.1.0.0.0':
    an apply by role booker inserting into MyBooking fails with "grizzle internal invariant: the installation stores
    relation MyBooking, which a write statement wrote" (adapter/witness/keylaw.ts tableOf, from hostRefused at
    adapter/apply/run.ts). The shape: a role writes through a query entry whose name is not a stored relation's
    (MyBooking, Booking's rows by the caller projected on room and during), and its ChangeSet adds two facts of one
    key, which the host refuses before any statement. The suspected cause: the host's key refusal names the entry it
    was stated against, while the served refusal tables (served/refusals.ts keyLawsData `tables`) hold only stored
    relations by their own names, since 64a22953 cut to the relations a role's writes change; the served `entries`
    map, keyed by each entry's target, already holds the entry's key mapping, so hostRefused should resolve an
    entry's name to its target's table, or the refusal should name the target. Whether it predates 64a22953 is
    unchecked. Neither downstream reaches it: edullm's learner and pantry's author write through no query entry (the
    `entries` of both served files' refusals are empty at main), and their whole entries keep each relation's name,
    which the tables hold (app.json 8 of 8, author_app.json 251).
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
- **Served explain chunks under the protocol's bound, not the session's (FORMAT, after the pin):**
  adapter/served/explain.ts explainChange cuts a statement's executions under `inForce(bindFrame)`, where an
  application (adapter/apply/run.ts) cuts under the leased session's `messageMaxBytes`. On a session whose bound is
  below the protocol's, explain plans nested rows inline that an application stages, and the flight's builder refuses
  the explain as InputTooLarge (message). Explain should cut under the session it leases, as an application does.
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
      hostEvaluator) and pattern-order.ts and lawPatterns read its lowered matches; lowering plain into the extension
      DAG and base only on refusal, a try-then-alternative that leaves unreachable nodes and moves DAG labels.
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
- **One statement per write stratum (waste):** the write executor keeps carriers (a TEMPORARY table per write) and the
  sequential realization, with UnorderableStratum refusing what it cannot order. Making every stratum one statement
  (sibling data-modifying CTEs reading the stratum's state) deletes both, but rewrites the insert, put, delete, serial
  and entry protocols (4-5k lines). Deferred 2026-11-08 behind ONERTT-WRITE's one-flight family writer (F2).
- **A non-finite Decimal head literal in a derived relation a rule reads:** ±Infinity, NaN or past 1000 digits, read
  by a check, key or selection, still fails closed (a literal never stands first). Closing it needs engine-built
  queries to carry InferredFieldDesc literal types through their own refs and decode path, apart from authored ones.
- **Patterns held as data (G3, punted by the owner 2026-11-08):** a check that a value matches every pattern a closed
  relation lists for its key, e.g. one row per (domain, pattern), compiled into the CHECK as each key's patterns ANDed.
  It would delete qti-pie's product regex (~1.2 MB of install SQL for NCName). Until then qti-pie keeps it.
- **edullm's workarounds, for the owner (2026-11-08):**
  - `Query.bind` exists only on plain queries, so an Ordered with attachments cannot be a bound import; edullm ports
    pantry's document scan as a child under its own parent instead.
  - `Compute.cast` refuses an aggregate, so a count reaches natural through a bound sub-query under
    `Compute.nonnegative`.
  - `Db.open`'s own round trip: edullm asks that its checks travel in the first call's flight (owner deciding).
- **qti-pie's asks, for the owner:** ~/.cache/gr8des/integration/fallback-scan.md #2–#13, and Compute.matches over
  patterns held as data. #7 (row order for the regex cache) is performance machinery, ruled out.

### qti-pie's after-pin queue (qti-pie's sweep, relayed by edullm-30 2026-11-09)
In qti-pie's priority order, each with its lane; each deletes code pantry or edullm keeps today. It lands after the
owner's post-pin order (the staged-imports SSI fix, the compute test fix, the held fill-order, multi-hop and GiST
fixes, LOADER's served matchers and admitted literals), items 1 to 6 first. A new feature still needs its correctness
need named in its commit.
1. A Db that holds only `workload`: db.get, execute, page, compile, apply, refresh and explain deleted (CULL, with
   LOADER's share of the deletion split).
2. The rowless ChangeSet builder (CULL, its builder series).
3. A law's id exported from the schema, and lawKeyOf, so pantry drops its committed LawId dictionary; RefusedLaw names
   no QTI law-table today (ARTIFACTS2).
4. The quadratic commit cost of rules over queries (NEGATION).
5. The cost of compiling the law model and building the Qti value (WORKLOAD2).
6. A fixed target's UNIQUE reuses one index across column orders: qti-pie's `_init` holds 7 duplicate index groups
   (GENERATE).
7. A Compute text split (SHA256). No substring, split_part or pattern group exists, so pantry splits on the host and
   writes the pieces as rows (IDREF, header and tolerance tokens, identifier leads and trails, href pieces, reading
   segments, unordered pairs). It must be total under a matches guard, IMMUTABLE, and carry the byte bound. Repro:
   ~/.cache/gr8des/lane-k/gap-split/repro.ts.
8. Patterns as data: REGEX2's served matchers (LOADER, its (a)).
9. regexMaxRepeat exported (LOADER).
10. An installation map, and a ChangeSet host preview (FORMAT).
11. Folds stepped by a closed relation (ONERTT-WRITE2).
12. An opt-in role namespace, grizzle#10 (GENERATE).
13. A generated term over a drawn field (SHA256).
14. Type checking of a rule's nested sources (NEGATION). A derived relation a rule's side reads whose definition matches
    or negates a query or derived relation that aggregates, orders and takes, attaches, approximates or recurses, or
    negates one that negates in turn, type-checks and is refused only at runtime, UnsupportedLawFamily from
    analysis/theory/query.ts's Flattener, because RuleRead (types/derived/derived.ts RuleReadOf) reads the definition's
    own arms and never what they match or negate. The fix: r.match and r.not record in the rule's facts the refusals of
    the source they read (a derived relation's own RuleRead, a query value's arms' refusals, and for r.not whether those
    arms negate, which UnionArm would then carry), find carries their union into the arm it makes, and ArmRefusal adds
    them with the engine's words, linear in the matches and filters; then the schema agreement's derivedProbe draws a
    matched and a negated query that aggregates, and one that negates in turn, as faults.
15. A stream over an ordered query (PORT-Q1).
16. A family whose member side is a selection (ONERTT-WRITE2).
17. A containment into a selection that a wider key holds (BIND).
18. A counted family over a derived relation: a family reads stored tables only, which keeps pantry's isNcName name
    rows (D27/D29) out of the database (CHUNK).
19. collapse of an unbounded text inside a query, refused today without a length bound; it also blocks D27/D29
    (PORT-Q1).
20. A family that groups by a generated field: a family's group key is caller fields today, which keeps 3 of pantry's
    13 copies host-written (CHUNK).

### Next
- **PostgreSQL:** repin to 19rc2 when it is released on 2026-11-12 (pin.env, rebuild, re-init, delete the 19rc1
  build; RC2 includes the recursive-UNION hash_mem fix, so that patch goes; confirm DROP DATABASE … WITH (FORCE)
  beside parallel autovacuum and the RI fast path with a cast). Repin to 19 GA on 2026-11-19; the relcache patch is
  rebased and kept until a release includes it. Tell qti-pie first: its database lives in the cluster.
- **`bench:full` on a quiet machine.**
- **Test layout:** tests move into packages/*/test, with their mutate and fallow paths and the docs.
- **RDS IAM** against a real RDS.
- **Worlds page coverage:** the worlds boxes never page past the first page. A probe of the exhaustive box reaches
  compilePage 36 times and makes no after or before request, and the random worlds pass a plant that answers every
  optimized after request with its before statements. So the worlds artifact differential
  (test/support/worlds/execute/artifacts.ts) covers only first and last page requests; test/pg/page carries anchored
  pages, and catches that plant.
- **Cross-repo, outside school hours for edullm:** grizzle's packages/testing differs from superstarter's in 43 files.
  Reconcile them, then copy the library into edullm with the shared lint standard.
- **The swarm core's shared-field column (ONERTT-WRITE2, 2026-11-09):** the core test/support/families/fill.ts gives
  each family a group column of its own, so the families swarm never draws pantry's importWrite shape: a family
  member's group field that a containment also reads, at every field of its target, which makes that containment's
  foreign key immediate and puts the member's insert before one owner's insert and another member's after it
  (AssembledReference contained in TestReference, beside its PlacedReference members). test/pg/write/stratum-order
  draws that shape alone (option b). When the core grows, give it such a shared-field column so the swarm draws it.
- **pg/fin/fold-ends met 40001 once, with no writer beside it (WASTE-QTI, 2026-11-09):** the full run at f6f1afbf
  (TEST_SEED=1966458093, the steered phase, case 24) failed one apply with TransientFailure 40001. Replayed three times
  at da0e9a93 it passes. Nothing in its database writes beside it: the file claims its database under an advisory lock
  (substrate/shared.ts claimSharedDatabase), runs its cases one at a time (concurrency 1), and its other statements
  (cleared's TRUNCATE, tableState's reads) are each committed before the next apply. The cluster was running several
  lanes' pg suites at once, and PostgreSQL's SERIALIZABLE bookkeeping is shared by the whole cluster: that load, not
  a writer in its own database, is the candidate cause. Record the next one with pg_stat_activity of every database at
  that moment. Replay:
  `TEST_REPLAY='pg/fin/fold-ends:5ffffffffffffffffe739ce739ce739ce739ce739ce739ce739ce739850a142850a142850a142850a142850a142850a1429f3e7cf9f04:1.0.f.1.a.0.2.0.1.0.0.0.1.0.2.0.0.0.0.2.7.7.0.3.2o.7.7.8.3.mk.3.0.3.4.f.7.4.1w.5r.9b.1.0.6.b.f.1d.26.1e.24.0.0.0.9.q.o.i.62.1m.3.1.0.7.b.q.16.2t.2j.e3.0.2.5.6.d.h.9.2p.8c.0.3.4.1.u.17.w.29.90.2.1.4.5.1.h1.3.8.5.1.2.bm.1.1.0.0.0.2.0.0.2.1.0.1.0.1.1.0.0'`
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
