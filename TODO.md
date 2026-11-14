# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## After 1.0.0-beta.1

1.0.0-beta.1 is on npm (2026-11-08), tagged v1.0.0-beta.1 at 2e979b3c. Main carries the README rewrite and the
post-beta swarm's fixes for the next release.

### After the 1,000-children goal (the owner's pinned goal, 2026-11-10)
- **A read-back over a delta no one statement makes is refused (CARRIER, 2026-11-11):** a read-back runs inside the
  one statement that makes its delta, whose rows exist nowhere else, and no delta carrier is left, so
  ReadBackCrossesStatements refuses three crossings: a side two statements make, or a statement of another stratum
  nets (one relation in two strata, an ownerPut's UPDATE and insert half, an array or Stream inserted into a relation
  with serial fields, whose complete and generated classes are a statement each; an insert of complete facts and a
  delete of one relation in one stratum never net, READBACK 2026-11-14, so each read back compiles, the shape of
  edullm's publish of PublishedTest, while a generated addition still nets with its stratum's removals, its drawn
  values possibly a lagging sequence's repeat of a deleted fact's); two sides two statements make (a put's added and
  removed read in one read-back); and a relation it reads as state written at or after the delta's statement (another
  part of a one-statement stratum, a write an immediate key holds after it, a later stratum). Follow-ups, each on a downstream's ask: (1) state written in the riding
  statement itself, read as that statement's snapshot less the keys it changed plus its added rows, which needs the
  isolation extractor to push key equalities into UNION ALL arms; (2) a mutable put read back on both sides as one ON
  CONFLICT DO UPDATE with RETURNING old; (3) an ownerPut's added side in one statement, its UPDATE and insert half
  touching disjoint keys; (4) an array of a relation with serial fields read back on added or met: both serial classes
  in one statement, which needs the generated class to meet the complete class's rows of the same call at its arbiter
  and at every other key without seeing them in its snapshot (a query member leaving the serial fields out compiles
  now), or a crossing of its own naming the two classes.
- **Member and shared sub-query carriers stay per call (CARRIER, 2026-11-11):** a stratum realized statement by
  statement still carries, in a temporary table created on every call, a described member two of its statements read
  (an immutable put's displacing deletion and insert half, an insert and its sequence advance, a deletion's D EXCEPT A)
  and a sub-query several members share, and the statements reading one plan again on every call. The queue fixture's
  claim keeps two (Work mutable) or three (Work immutable). Removing them is "One statement per write stratum" below.
- **startSitting's insert into Served replans under COMMIT (CARRIER, 2026-11-10):** the cause is not found. Finding it
  needs runs of ~/.cache/grizzle-release/CARRIER/m/replay.mjs.
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
  siblings through shared node and package ids, which no seal the certifier holds covers, so pantry's replaceWrite
  stays a possible pivot of a dangerous structure (NEGATION, 2026-11-10). The only routes to a proof are nested overlays
  with a sibling seal (a qti-pie change) or closed groups. Until one lands, learners reach content only through a
  publication layer, never the importer's live rows.
- **A READ COMMITTED insert through a query entry would meet 42501 (RC2BEHAVE, 2026-11-14):** no role that inserts
  through a query entry is certified READ COMMITTED today, because the certifier reads its precheck's key probe as a
  read it states no fact of (program/isolation/extract.ts). If the certifier learns key probes and admits it, an
  occupant outside the entry committed between the precheck and the INSERT meets PostgreSQL 19rc2's SELECT-policy
  check on the conflicting row, which runs before any WHERE (nodeModifyTable.c ExecOnConflictSelect), so the insert
  raises 42501. The answer then: read a 42501 at such an insert statement, by statement and SQLSTATE as UniqueAbort
  reads 23505, as a TransientFailure `HiddenOccupant { relation }` whose retry's precheck refuses on the key's law,
  added to every closed transient vocabulary. test/schedules/write/entry-occupants.test.ts holds the level today.

### After the qti-pie and edullm repin (the owner, 2026-11-08: ship the repin first)
- **The beta.2 gate (owner, hard):** one full suite run (check, unit, types, PostgreSQL, deep) and `bench:full`, with
  every performance gate passing, both perfect on the exact commit; then the owner's go.
- **physical/serving's needed check can call a needed B-tree unneeded (GIST, 2026-11-10):** a generated span predicate
  binding a boolean whose name sorts first, with a range after it planned beside the GiST index it creates and nothing
  reordering that index, under a boolean loaded half and half: btree_gist splits the boolean cleanly, so the needed
  check would call the fix's B-tree unneeded. That is a false red of the suite, never a false claim of the engine. The
  Shift and Rota kept cases pin the mechanism with a skewed boolean.
- **One backfill UPDATE per table and level (MIGBATCH, after the swarm gate):** each UPDATE writes a new version of
  every row it names, which holds its space until the migration's transaction ends, so N UPDATEs of a table grow it N
  times over before COMMIT. A table's member parts already share one UPDATE where their reads allow
  (deploy/diff/backfill.ts merged), since each covers every row of its table and an inner join keeps them exact. An
  owner's UPDATE (its owners with a member), a copy's (the rows its axis names) and a tree's ends (its owners) name only
  some rows, so joining one beside another drops the rows the other names: they need `UPDATE T t ... FROM T k LEFT JOIN
  <part> ON <its predicate over k> WHERE t.ctid = k.ctid`, each column set by CASE WHEN its part matched, which the SQL
  AST cannot state (JoinStep is `on` or `cross`). The change is a LEFT JOIN step through sql/ast.ts, print.ts,
  transform.ts, every exhaustive JoinStep reader and the test interpreter's UPDATE model, reviewed on its own; then each
  part's level is 1 + the highest level of any part whose drawn columns it reads, one UPDATE per (table, level). Its
  property: pg/migrate/backfill's values against the existing oracle, and exactly one UPDATE per (table, level); its
  plant, one UPDATE per part again.
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
- **One statement per write stratum (waste):** the write executor keeps member and shared sub-query carriers (a
  TEMPORARY table per write) and the sequential realization, with UnorderableStratum refusing what it cannot order. Making every stratum one statement
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
- **qti-pie's asks, for the owner:** ~/.cache/gr8des/integration/fallback-scan.md #2–#13, and Compute.matches over
  patterns held as data. #7 (row order for the regex cache) is performance machinery, ruled out.

### qti-pie's after-pin queue (qti-pie's sweep, relayed by edullm-30 2026-11-09)
In qti-pie's priority order, each with its lane and a stable label (a closed item is deleted, the others keep theirs);
each deletes code pantry or edullm keeps today. It lands after the owner's post-pin order (the staged-imports SSI fix,
the compute test fix, the held fill-order, multi-hop and GiST fixes, LOADER's served matchers and admitted literals),
Q2 to Q6 first. A new feature still needs its correctness need named in its commit.
- **Q2.** The rowless ChangeSet builder (CULL, its builder series).
- **Q3.** lawKeyOf, so pantry drops its committed LawId dictionary (a law's ids ship as lawIdsOf, public/schema.ts);
  RefusedLaw names no QTI law-table today (ARTIFACTS2).
- **Q5.** The cost of compiling the law model and building the Qti value (WORKLOAD2).
- **Q7.** A Compute text split (SHA256). No substring, split_part or pattern group exists, so pantry splits on the host
  and writes the pieces as rows (IDREF, header and tolerance tokens, identifier leads and trails, href pieces, reading
  segments, unordered pairs). It must be total under a matches guard, IMMUTABLE, and carry the byte bound. Repro:
  ~/.cache/gr8des/lane-k/gap-split/repro.ts.
- **Q8.** Patterns as data: REGEX2's served matchers (LOADER, its (a)).
- **Q10.** An installation map, and a ChangeSet host preview (FORMAT).
- **Q11.** Folds stepped by a closed relation (ONERTT-WRITE2).
- **Q12.** An opt-in role namespace, grizzle#10 (GENERATE).
- **Q13.** A generated term over a drawn field (SHA256), and over a copied (accumulated) field too: pantry's node.ts
  `ancestry` and attributes.ts `slot` read one.
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
- **Q20.** A family that groups by a generated field: a family's group key is caller fields today, which keeps five
  pantry fields host-written and checked: CatalogRef.token, LomLanguage.tag, SsmlAttribute.value, PlacedId.copy, and
  DocumentId.id, the one without a GRIZZLE-PENDING marker (CHUNK).

### qti-pie's feature asks, by the pantry code each deletes (edullm-side survey, 2026-11-14)
Logged only: each waits for the owner's go, and for its correctness need named in its commit. Ranked as the survey of
pantry's grammar/ and qti/ ranks them (~/.cache/gr8des/qti-sweep/pantry-grammar-qti.md, "What grizzle should fix",
read against main 5b049abf); a Q label points at its entry above.
1. **Q7, a text split or substring:** a total Compute split or substring under a matches guard, IMMUTABLE and byte
   bounded. Deletes the host splits and their concat-fold proofs in about 8 relations (Idref, TextIdref, VariableRef,
   ReferenceSegment, Reading, Tolerance, the Reference pieces, Node's first and last).
2. **Q16, a family over a selection:** a family whose member side is a selection, and a relation that owns and is a
   member of one counted family. Deletes about 10 stored copies (GapInteraction, AriaValue, BindingName, PciModuleForm,
   the LeastCount/MostCount split, BodyXmlLang, PlacedBodyXmlLang, Operand).
3. **Q8, patterns as data:** a pattern held as a row's value rather than one domain per pattern. Deletes
   grammar/domains.ts's regex product, about 690 lines, and about 1.2 MB of install SQL.
4. **Q18, a counted family over a derived relation:** a family whose member is a derived relation. Deletes 5 stored
   relations, which become queries (TestReference, PlacedReference, PlacedVariableRef, ReferenceDocument,
   PlacedDocument).
5. **A typed delete of every row by one field:** one delete of each relation's rows chosen by a field (a package),
   or a replace by key prefix, with a relation's caller fields as a value. Deletes qti/logins.ts:284-2255, 175
   copy-pasted delete blocks of about 1,950 lines, with their 176-name destructure, the deletingEvery guard and 55 omit
   lists.
6. **A name on every law, plus Q3:** `key`, `contained` and `mirrors` take a name as `check` does, and lawKeyOf.
   Deletes 26 hand-kept law-name tables (the `*LawsByName` records) and test/law-namer.ts.
7. **A boolean term as a condition:** a boolean term usable where a predicate is. Deletes 15+ `eq(term, true)` sites.
8. **Q13 over copied fields:** a generated term may read an accumulated field. Makes node.ts `ancestry` and
   Attribute.slot generated and deletes TableScope, MathAlignScope and SsmlScope.
9. **Q20:** a family grouped by a generated field. Generates the five host-written fields its entry names.
10. **Q19, collapse inside a query:** collapse of an unbounded text in a derived relation. ManifestId, ResourceId and
    Dependency become queries over Attribute, and about 12 copy containments go.
11. **A fold's text kept out of index keys:** a digest in the axis UNIQUE, the text proved by the fold's CHECK. Deletes
    node.ts's bounded string-value fold and its hand lists of folded kinds.
12. **Rules over recursive queries:** a rule side may read a recursive derived relation. Deletes mathml-share.ts's
    host-computed dominance ranks (MathRank, PlacedMathRank) and closes its foreign-element hole.
13. **A text digest:** `Compute.sha256` over text, digesting its UTF-8 bytes; today it reads bytes only (engine
    registry.ts `bytesDigest`). Lets pantry compare free text by a digest column where it now writes query rules
    (qti-pie docs/grizzle-findings.md, found on qti-cutover-20261114b).
14. **An unbounded text behind a digest-keyed index:** an index a rule probe needs over an unbounded text keys its
    digest, and the probe compares the text itself after the digest; item 11 is the fold's case of it. Today making
    ObjectTitle's title unbounded fails compile with UnrepresentableKey, because the "lom-title" probe wants
    (package, titleValue, start). Lifts the bound on long titles, and with item 11 on an element's string value,
    qti-value, LOM strings and whole IDREFS values (same source).
15. **A level's snapshot built in-process:** a public `compileSnapshot(login)` on @bjornpagen/grizzle/compile, the
    snapshot.json value generate would write for the login's base serving the login, so compileServed can compile a
    level's login offline under its own installation. It must be the one composition generate's draft runs
    (cli/generate.ts plannedLogins), never a second copy beside test/support/compiled-served.ts compiledSnapshot.
    Asked by the pantry port's export/scan.test.ts, which compiled ScanProbe under Qti's snapshot and is rightly
    refused UncoveredRead; compileServedOnce stays unexported (its files are served by onceCalls alone).

### qti-pie's test-survey asks, for the owner to schedule (2026-11-14)
From the survey of pantry's test suites (~/.cache/gr8des/qti-sweep/pantry-test.md, section 4), logged only.
- **An orphan family member refused under its family's law:** a member appended under an owner the stratum does not
  insert is a CompileError that names no law (write/family/edit.ts:507); it should be the family law's refusal, with
  a witness.
- **One exhaustion split across Vitest files, checked:** an exhaustion's fibers share one thread, so a CPU-bound
  exhaustion uses one core whatever its concurrency.
- **Text keys past PostgreSQL's B-tree item size:** so pantry drops its "Key text bound" law.

### Next
- **The repeats left in a login's served file and OpenAPI document (OUTPUTSIZE, 2026-11-14; main: not now):** since
  5e47fdd7 every repeated shape is written once wherever a reference can stand, but some are still written again where
  none can. Measured on qti-pie pantry's author_app (f65ea15e plus 5e47fdd7's change) as the bytes a reference would
  save over every repeat longer than it (~/.cache/grizzle-release/OUTPUTSIZE/scripts/rest.mjs). These figures replace
  5e47fdd7's estimate of about 90 KB and 85 KB. Each item needs its prerequisite first:
  - Served file (14,908,504 bytes; about 397 KB to save, 2.7%):
    - Revive marker lists (`~`): 88,011 lists, 509 distinct, 334,095 bytes. Prerequisite: the format reads a marker as
      part of the record or array it marks, so a reference can stand for both; for example, a record's keys and marker
      are one frame the table holds.
    - Roster handles, spelled in `rosters` (the codebook a load reads first) and again in a WireScalar's `handles`:
      62,785 bytes, 34,901 of them Governor's. Prerequisite: a WireScalar names its roster and reads the handles from
      the file's rosters.
  - OpenAPI document (819,464 bytes; about 166 KB to save, 20%):
    - `properties` maps that a fact's closed object and the role witness's key object share: 144 maps, each written
      twice, 98,871 bytes. Prerequisite: an allOf core for closed objects (`allOf` over a shared core, with
      `unevaluatedProperties: false`), so the core with its `properties` is one component.
    - Roster handles spelled in a schema's `enum` and again in the wire's `handles`: 14 lists, 63,099 bytes.
      Prerequisite: the same WireScalar that names its roster, with each roster's handles written once in the document.

  Once these land, the "each shape once" properties (test/unit/served/file.test.ts, test/unit/live/openapi.test.ts)
  extend to these positions.
- **A redraft can't see a started draft's no-transaction file (fail-open edge left by 7abb6fc4):** decideFolder refuses
  a redraft whose next file runs outside a transaction (`redraftUnverifiable`), but it reads the redraft's file at that
  ordinal. If the started draft's file there ran outside a transaction and the redraft's runs inside one, the ledger
  can't tell whether the old one partly ran: no row records what the started draft's files were. Representation: the
  ledger records a begun row before a no-transaction file's first statement (or the folder row records which ordinals
  the started draft ran outside a transaction), and decideFolder refuses a redraft over any begun-but-unfinished file.
  No downstream is exposed today: QTI resumes at 02, a transactional file.
- **Turbo hashes grizzle's own sources into every task (fold into the toolchain switch, lane TOOLCHAIN, F3):** the root
  package.json devDepends on @bjornpagen/grizzle, @grizzle/devtools and @grizzle/testing (workspace:*), so turbo counts
  their sources in the global hash (globalCacheInputs.hashOfInternalDependencies), and a one-line edit in
  packages/grizzle runs all 21 check tasks again. Move test, bench and scripts into a workspace package of their own, so
  the root depends only on the tooling. The toolchain switch restructures the root anyway.
- **A family member's put that moves a key is witnessed by PostgreSQL alone (WITNESS, 2026-11-11):** every insert now
  probes each unique object it does not arbitrate in its own statement, a family's additions and a planner's row insert
  included (write/family/statements.ts candidateGate), so a stated row meeting one is refused with its key. A family's
  removals statement does not (write/family/removals.ts): its re-placing INSERT and its UPDATEs in place of a put's
  caller fields still raise PostgreSQL's 23505, whose witness the host names only where every row holds one value
  (runtime/write/witness.ts uniqueJudgement), so a put of a member moving a secondary key onto a stored one is refused
  `unreported`, against README's Witness. The statement deletes first, so a snapshot probe sees its own deleted rows and
  must pass over the keys it deletes; an UPDATE's uniqueness is checked row by row, so a swap of two members' values is
  refused where the final state is lawful, as put/choose.ts uniqueOutsideKey avoids for plain relations. Reach: no
  qti-pie or edullm put of a member.
- **A family statement's unseen occupant is a law outcome (WITNESS, 2026-11-11):** a 23505 or 23P01 a family statement
  still raises at a probed object is an occupant committed past its snapshot, yet family steps list no unique aborts
  (adapter/outcomes uniqueAbortsAt), so it reaches the classifier as `invariant-rejected` with an `unreported` witness
  where the insert protocol's is TransientFailure{UnseenOccupant}. List each probed object of a family INSERT as its
  step's abort, as the protocol's probed inserts do. Concurrency only; no stated row reaches it.
- **Every insert's unique check at a flat success cost (WITNESS, 2026-11-11):** each insert probes every unique object
  besides its arbiter for every row, beside PostgreSQL's own check, about doubling unique-index work on success. ON
  CONFLICT DO NOTHING with no target arbitrates every unique and exclusion object at PostgreSQL's one check, and only the
  rows it skipped, the met rows, need classifying: a stored occupant at each object in law order, else a row the same
  INSERT returned, else an occupant the snapshot cannot see. Soundness to settle first: at SERIALIZABLE an unseen
  occupant is 40001 (ExecCheckTupleVisible), but the arbitration's own fetch takes no SIRead lock, so each met row is
  read again under the snapshot as the `every` arbitration does; at READ COMMITTED the arbitration skips a row committed
  past the snapshot, which no read of the statement can name, so a met row unclassified there is an unseen occupant
  whose constraint is unknown, and the certifier reads a targetless arbitration and a met read at READ COMMITTED as
  opaque (program/isolation/extract.ts), which would lower every such role to SERIALIZABLE.
- **Retirable units, served (RETIRE2, approved for den 2026-11-11):** a schema declares units and installs their fence,
  hold and retire functions, and the certifier counts a retirement as no change; nothing serves them yet. Owed: every
  served change member that touches a unit's body calls its hold before its first statement that does, refused
  `UnheldGroup` where it touches a group the call does not state; `ChangeSet.retire`, the role option `retire`, the
  outcome's retired counts, EXECUTE grants, the README's served half and SKILL.md. The design, decisions and plants owed
  were in ~/.cache/grizzle-release/RETIRE/handoff.txt, lost with the VM (2026-11-12). The plants
  test/unit/write/hold.test.ts's header names were lost with it: RETIRE2's hold-omitted and hold-after
  (~/.cache/grizzle-release/RETIRE2/plants) are rewritten with ChangeSet.retire's work, and TREEORACLE's
  hold-header-unordered is no longer in ~/.cache/grizzle-release/TREEORACLE/plants either.
- **Reads forward PostgreSQL's bytes (WIREPASS, the owner, 2026-11-11):** the live wire decodes PostgreSQL's JSON
  (attachments are aggregated as JSON in the served statement, lower/shapes/attach) into host values, then re-encodes
  them in carrierWire's spellings (live/wire.ts): int8, numeric and money as strings, bytes as base64. That is a
  decode/encode cycle per row on every read. Have the served statement build the wire's spellings itself (int8 cast to
  text inside the JSON build, and so on per carrier), so the server forwards PostgreSQL's bytes into the SSE data line
  untouched. The live diff compares rows, which works on bytes only if spelling is canonical both ways: carrierWire
  already guarantees one value per spelling, and it must add one spelling per value (float specials, -0, numeric
  trailing zeros, date and span forms). Think it through and fix it once live works; the oracle is byte equality with
  today's encode over every carrier.
- **PostgreSQL:** repin to 19 GA on 2026-11-19 (pin.env, rebuild, re-init, delete the 19rc2 build); the relcache
  patch is rebased and kept until a release includes it, and so are the btree_gist backport of b82d69abf6 and the
  PL/pgSQL line lookup, each dropped once its release includes it. Tell qti-pie first: its database lives in the cluster. When
  the patch next changes, restate its header's "Its output matches stock 19rc1's except for that last line" from a run
  on the stock release it is rebased onto: the RC2 rebase left that RC1 observation as it was, since any edit changes
  the patch's SHA-256 in pin.env and so rebuilds every build.
- **Named clusters each size themselves as if alone (PRIVATECLUSTER, c30406e6; main's decision 2026-11-14: no change):**
  every cluster GRIZZLE_PG_CLUSTER names takes clusterSize, the one machine-derived formula. On cassowary a cluster
  is max_connections 4359, shared_buffers 304,064 blocks, max_pred_locks_per_transaction 30, 66 replication slots and
  walsenders, shared_memory_size 2882 MB; init took 13 s and destroy 4 s (throwaway cluster 5460, 2026-11-14), with
  247 GB of RAM, about 75 GB available and 49 GB of swap in use at the time. Revisit with numbers only under memory
  pressure, by sizing a cluster from what it serves (networkWorkers for a test tier, one lease for a migrate or an
  import), and mind the two catches: a down-sized cluster fails the doctor's sized checks, which test:network's global
  setup runs, so clusters would split into two kinds, one that serves migrates only; and the measured per-worker buffer
  bound (workerDatabaseBytes, 38.9 MB) is below PostgreSQL's 128 MB default shared_buffers and below a pantry
  database, so a one-run cluster may want PostgreSQL's own defaults instead (a peer's hand-made 5442 had
  max_connections 100 and ran pantry's migrate in 1 min 35 s, against over 30 min on shared 5433).
- **`bench:full` on a quiet machine.**
- **Test layout:** tests move into packages/*/test, with their mutate and fallow paths and the docs.
- **The fill kernel's rows have one handle, their `id` (RESTATED, 2026-11-12):** test/support/families/fill.ts follows a
  row across a stored instance and its restatement by its `id` field (writtenRows' byId map, every memberOf owner,
  instanceFacts), and a tree's root fields are named by its root's id (rootValuesOf), so G4 (test/pg/write/reinsert,
  again.ts renamedInPlace) never renames a tree's root: that states its whole tree again under another root, its nodes'
  ids kept, a second tree PostgreSQL holds beside the stored one, which the model merges into one. A tree's primary key
  holds its drawn start, which shifts with every node added before it, so the key cannot be the handle either. Split a
  model handle from the `id` field through fill.ts and the swarm suites, and draw a root's rename again.
- **The worlds' page:anchored feature (WCOVER, 2026-11-10):** WCOVER-01 compares anchored pages but requires no feature
  that reaches one. With page:anchored required, isolation reads at TEST_SEED=3971498375 held a led case past its hang
  limit: both reads leads take every required feature, and a pending one keeps directTransaction's afterBegin
  look-ahead (test/support/worlds/drive/suite.ts) running. Require it again once the reads leads stop looking ahead at
  features a direct transaction can't reach. The cause is read from the code; no run confirmed it.
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
    lower/conservative/sharing.
  - Hand verdicts through element(...) inside generators: unit/lower/feedback (count its blocks and scans by an
    independent walk, depths int(1, 5) for element([1, 4, 5])) and unit/analysis/logical/logical (hold it to universe
    truth, option a); unit/analysis/theory/families keeps a fixed tree branch.
  - Fold unit/page/compile's bounded heterogeneous union refusal into unit/page/total and delete the file.
  - Slim: types/evidence/agreement (reorderedVerdicts re-derives notes; floor witnesses recomputed),
    lower/rewrite/universe, analysis/small/claims (a second Reference) and logical/evidence (logicalUnsound re-checks
    key proofs per input), types/schema/budget/families (armed and disarmed both run full checks). Not profiled yet:
    types/schema/budget/scaling, types/query/budget/scaling.
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
- **The type tier's stall guard reads whole seconds of CPU on Linux (PGLINUX, 2026-11-12):**
  test/types/batch/compiler.ts:165 reads a tree's CPU time with `ps -A -o pid=,ppid=,time=`, which procps-ng 4.0.4
  prints as hh:mm:ss with no fraction, where macOS printed hundredths. The guard's own property draws windows of 1000
  to 3000 ms (test/types/batch/batch.test.ts:574), so a short clean check could read no progress for a whole window
  and be judged stalled. Unverified (not run). /proc/<pid>/stat gives the time in 10 ms ticks.
- **Limit evidence names the macOS VM (PGLINUX, 2026-11-12):** measured limits whose environment is the 10-core macOS VM
  need revalidating on cassowary: packages/engine/src/core/limits.ts:141, 362, 461 and 626, test/support/limits.ts:27,
  test/support/power-pairs.ts:250, test/support/oracle/evaluate/power.ts:474 and test/types/batch/compiler.ts:46.
  flightMaxBytes (limits.ts:815-823) cites macOS refusing a write past INT_MAX with EINVAL; Linux caps one write at
  0x7ffff000 bytes and writes part of it instead.
- **The PostgreSQL build's optional features follow the host (PGLINUX, 2026-11-12):** scripts/pg/source.sh names only
  the features it needs, and meson's auto-detection turned plpython, selinux, systemd and nls on on cassowary and left
  libxml and uuid off; the VM's set was never recorded. No test reads them (test/support/kernel/catalog-alphabet.ts
  reads only share/postgres.bki); pinning them would make the build the same on every host.

- **Doomed foreign keys and rule triggers stand through the data steps (edullm, 2026-11-12):** a migration drops the
  old laws it replaces only in its removals (05/06), after the reviewer's data steps in 02-structure. edullm's identity
  migration retracts about half its imports in a data step while 224 old foreign keys and 41 rule triggers still stand,
  so every deleted row queues an after-trigger event per key in memory. edullm drops the doomed keys and triggers in
  its own data step and makes the drafted drops `IF EXISTS`, a downstream workaround. Draft the drops of every
  foreign key and rule trigger that nothing after the data-step slot reads before that slot (never a primary key or
  UNIQUE: the fills join through the old keys' indexes), with a property that no doomed RI or rule trigger stands at a
  data step; then tell edullm to delete its workaround on its next migration.
- **Unreported witness on a native unique met by a family insert (WITNESS, known red on main):** a family INSERT that
  meets a native UNIQUE (a member's primary key, an ordered family's (group, index), a tree's key) is refused with an
  `unreported` witness (runtime/write/witness.ts uniqueJudgement; adapter/witness/classify.ts), against README's
  witness contract. test/pg/fin/counted-set and test/pg/write/reinsert stay red on it. The fix is on the live branch
  (283f0295, d7cc2586, 899b370d: every family insert probes each unique it does not arbitrate); main takes it only by
  the owner's word, since nothing moves from live to main.

### Parked by the scope lock (the owner, 2026-11-10)
- **A whole delete that reaches another family's member is refused when it compiles, though the family's axes refuse
  every partial group at commit (WHOLEDEL, 2026-11-14), the owner's call:** a delete of a relation that owns a family
  and is no family's member is refused where a relation nested under it is a member of a family whose owner no delete
  of the stratum removes (write/frontend/compile.ts unitBelow; README "Families"). That rule does not stop partial
  groups; the family's owner, predecessor and last axes do, at commit, which 73c7406e already relies on for crossings
  ("which rows the deletes name is the call's"), and a stratum that adds a delete naming zero rows of the other owner
  passes the rule today. Under it no program of the platform fixture can delete any WorkspaceLimit: its charges nest
  CreditDebit, a member of CreditGrant.debits too, so setCaps lost its removal of the months not given and
  test/schedules/platform/cap.test.ts its arms that remove a month. With the rule at commit, setCaps would compile,
  removing a month without debits whole, its charges with it, and refusing one with debits at commit on grantDebits.
  That is a contract change (README, and test/pg/write/whole's required feature "the delete without the other
  relation's refused"), and neither qti-pie nor edullm needs it.
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
- upstream/v8-unicode-end-anchor-astral-class: V8 14.6 (Node 26.13) answers a unicode-mode pattern ending in `$`
  over an astral class wrongly from an unanchored start; V8 fixed it on main (7d259d7c2090, issue 571871980). The
  folder holds a Node backport patch and issue.txt asking nodejs/node to backport it to v26.x. Once a Node release
  carries it (`node repro.js` exits 0), the live branch's toEcma (scalar/regex/ecma.ts) prints a pattern's body as it
  is and startsAtStart is deleted, and the folder goes.
- upstream/ssi-summarized-conflict-out: not carried in grizzle's build (the owner, 2026-11-11: local behaviour must
  match stock PostgreSQL on RDS); the owner files it with pgsql-hackers after the archive and commitfest searches its
  CHECKLIST.txt leaves open.
- upstream/node: TextEncoder.encodeInto underfills an exactly sized destination for text holding U+0400 to U+07FF
  (nodejs/node#65994, fixed by #65997, unreleased). Once a Node release carries #65997 (repro.sh prints PASS on every
  line), restore encodeInto in packages/engine/src/codec/bytea.ts textArray, whose encode() per element is the interim
  and allocates per row, with test/unit/codec/text-array.test.ts and test/pg/write/text-arrays as its guards, and
  delete the folder.
- upstream/generated-column-collation-before-planning: PostgreSQL 19 can't choose a collation for a generated column's
  comparison of two texts that read no row (42P22); grizzle folds such constants on the host.
- upstream/plpgsql-lineno-rescan: PL/pgSQL rescans the source on every location-to-line lookup. The pin carries the
  fix as scripts/pg/patches/19rc2-plpgsql-lineno-binary-search.patch.
- upstream/btree-gist-multibyte-penalty: btree_gist's fix for multibyte text keys (b82d69abf6) is on master only. The
  folder holds the owner's unfiled text_utf8 placement test for master, and b82d69abf6 back-patched with that test for
  REL_19_STABLE. The pin carries the change as scripts/pg/patches/19rc2-btree-gist-multibyte-penalty.patch.
- upstream/gist-costestimate-column-position: a pgsql-hackers reply to BUG #15408, for PostgreSQL 20.
- upstream/relcache-planned-check-and-generation: the relcache patch the pin carries.
- upstream/fallow-unused-class-member-union-property: fallow credits no class member called through a property of a
  union-typed value, so .fallowrc.json keeps use and relationUse. File at fallow-rs/fallow, then drop the entries once
  repro.sh reports Cell.never alone.
- upstream/arkregex-zero-width-space-marker: ArkRegex reads a literal U+200B in a pattern as its own error or anchor
  marker, so grizzle's scan writes it as NUL and the host type writes it back (types/fields/source.ts, regex.ts). File
  at arktypeio/arktype, then delete the stand-in once repro.sh reports the control alone.
- grizzle/upstream/fallow: fallow reports class members read through a Map of the class as unused once the class
  implements an interface: FamilyEntry.folds, fold and axes (analysis/theory/families.ts), which the Normalizer reads
  through its Map of FamilyEntry (analysis/theory/laws.ts), since c665a759; dropping the implements clause alone does
  not clear it. Patch it in grizzle/upstream/fallow, then delete .fallowrc.json's usedClassMembers entry scoped to the
  class that implements RiddenFamily.
