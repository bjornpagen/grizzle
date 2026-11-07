# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## Now: the second beta, 1.0.0-beta.1

Owner 2026-11-06: everything in this section lands before the beta, in this order. The PostgreSQL build keeps only
what grizzle needs, no bug is known, no test is an example, and the type checker's cost grows linearly in every schema
dimension.

How the work runs:
- Owner 2026-11-06: approved; work autonomously to the end, deciding along the way, and hand the owner the one-line
  publish command. The test inventory (3.2) is written into this file, and wave 2 starts from it.
- Main reads the code and the tests itself and integrates. Up to twenty lanes run at once (owner 2026-11-06), in the
  main checkout, on main, with no branches, each owning named files. Lanes run no git. A lane runs only the targeted
  suites that show its guard passing and its planted bugs caught, one background run at a time; planted bugs live in a
  scratch copy under ~/.cache/grizzle-release/ with its own install.
- Main typechecks the integrated tree once, fixes what it reports, and typechecks once more. Then it commits and pushes.
  A push needs only a clean typecheck.
- Every tier runs together once all the coding is in, using half the machine. `pnpm test` runs first, then
  `pnpm test:network --maxWorkers=3` on server A once A is ours.
- Mutation runs use a scratch copy under ~/.cache/grizzle-release/ with its own `pnpm install`.
- This work is grizzle only.
- One copy of PostgreSQL (owner 2026-11-06): the cluster on 5433. The second copy, on 5435, was stopped and deleted on
  2026-11-06. Use 5433 once GG's run there has ended. Never run `pnpm pg reset`: another project's database lives in
  the cluster too.
- 5433 is shared with the qti-pie session, which tests its own database there. Before restarting 5433 or starting a
  pg-tier run on it, tell that session (cross-session message) and don't overlap its database tier. It tells grizzle
  when its runs start and end.
- Waves:
	- wave 1 is lanes P (section 1), R (the regex fix) and T (the type layer), with main taking the test inventory;
	- wave 2 is the test areas of 3.3, at most four lanes at a time;
	- wave 3 is the release (section 4).

### 1. The PostgreSQL build
- **Repin to 19rc2 on 2026-11-12, if the beta isn't out by then:** pin.env, rebuild, re-init, then delete the 19rc1
  build, source and cluster.
	- RC2 includes the recursive-UNION hash_mem fix, so that patch goes.
	- After the repin, confirm the two RC2 fixes that touch grizzle:
		- DROP DATABASE … WITH (FORCE) beside parallel autovacuum workers (the sweep runs it);
		- the RI fast path with a cast (grizzle pairs FK columns of identical types).
	- Tell the downstream session first: its database lives in the cluster.

### 2. No known bug
- **A containment's reverse index never refuses it** (K, the fix is in): its tests follow. A search over
  containments with unbounded source columns at every position, with and without a covering key and a source
  selection, and a bounded run too wide for one entry. Oracle: the schema compiles and every planned index is a proved
  B-tree, a proved GiST or a hash; on 5433 the reverse probe's generic plan uses an index, and a 10,000-byte text lands.
  Planted bug: every source column planned.
- **The key text budget leaves out the index tuple's null bitmap** (K): the fix is in, and a generated suite
  follows: a declared key, a key over a selection, an ordered family's axis and a tree's predecessor axis, each
  admitted at N and refused at N+1 where tight. `keyTextBytes`'s JSDoc and README say `fields` is every other column
  of the index.
- **A byte bound as a refinement, not a type** (K, qti-pie's 54 containments): `str.bytes(N, pattern)`, its CHECK
  `octet_length(VALUE) <= N` beside the pattern's, read exactly by the bound analysis, meeting any text in a
  containment as a pattern does. Test: texts at N-1, N and N+1 bytes in 1- to 4-byte scripts against the CHECK and the
  analysis. Planted bug: the bound made part of the type.
- **Compute's types and engine disagree** (W-agree, W-typesC):
	- integer exact division's refusal names the `proves` to add; Compute.numeric refuses a text operand; a span's
	  endpoint refusal and span casts between endpoint contracts in the types; README and SKILL state `proves`;
	- a partial operation's types print its precondition's Refusal only for an operand of the type it takes, and the
	  operand's type refusal otherwise, in the engine's order (`Compute.mod(cell.int, …)`, widthBucket over real, power
	  over integer, casts, the literal-first Refusal);
	- `Compute.cast(Compute.add(r.depth, 1), pg.integer)` in a generated field: the types accept it, the engine
	  refuses PartialOperation;
	- a containment into a side that is not a key, and a narrowing whose fit rests on bounds, are decided at compile
	  (the types track neither a key over a selection nor bounds): the populations draw them as declared classes;
	- a delete listing two facts that share a key with different payloads: the types refuse it, the engine admits it.
	  The engine refuses it too, as it does for an insert and a put (W-typesD).
- **Changing an owner's column that a family's derived value reads through a copy** (a fold step, a predecessor or last
  copy, a copy of a copy) is refused today (StaleDerivedRead, CascadedCopyAppend). Lane REFILL, on F's design: every
  stale path is refilled members-first, ahead of the change that would cascade into it, as a node of the unified
  schedule; the axes it writes around are deferred by schema analysis; one read flight locates the groups. Only a change
  sourced from a query stays refused. Guard: fill-order's follow-up writes every case and the stored rows equal the
  reference writer's; planted bug: a refill out of members-first order.
- **An absent key in a closed read raises a domain CHECK** (qti-pie, defect 3): `C.row` of an absent `C.at` casts NULL to
  the set's bits domain, whose `IS TRUE` CHECK raises 23514 before the law's three-valued logic can hold, so every
  lawful row of such a relation is refused. Lane CROW: the contract (C.at reads NULL, C.row the empty set, the law
  decides) over every domain that refuses NULL. Guard: a pg search over every read form, carrier and position, the
  downstream shape kept; planted bugs: IS TRUE on a NULL cast, a C.row reading NULL.
- **@grizzle/testing `matching()` refuses after expanding every class** (qti-pie, low): an unbounded `*`, `+` or
  `{n,}` is refused only after the pattern's classes are built, 2.8-4.3 s for XML's Char class. Decide the refusal
  from the repetition structure first. Test: a count of class expansions for refused patterns, 0. Planted bug:
  expanding first.
- **README limits the downstream census found:** the str.regex grammar (no lookaround, no \p), and that a generated
  NOT NULL column's 23502 fails the write as ExecutionFailure naming no law.
- **Watch first at the gate** (lanes' own risk notes for suites that have never run on 5433):
	- physical/oracle's new invariants on extended types, the money arm under ja_JP.UTF-8, the world-serving view-read
	  bound, Account's take plan in plans, the wildcard literal's column type, and the bits migrations;
	- the worlds rules suite (24 cases, the first to write coverage and alternatives laws through a Db);
	- test/pg/fields/set-padding, test/pg/package/consumer and the CLI drift suite.
- **test/pg/program/templates is still an example test** (W-physical).

- **Everything parked "after the beta" is fixed for it** (owner, 2026-11-06: "all these known issues must be
  fixed"). What remains, by lane:
	- REFILL: refill on an owner's copied column (above).
	- KEYS: rewrites' key claims on proofs; a projection drops a dependency on a dropped column; a lateral fixed column
	  in both directions; linear minimal keys over k joined relations; a closed relation's identical columns as one
	  class.
	- OPEN: date spans; family rows ordered by pattern input (after FOLD's brands).
	- FOLD: host values only inside the engine, ParamText/OutputText brands, every encode/decode round trip deleted.
	- PERF: the 1M-row plans under roles, index-served.
	- REP: regex membership from one compile-scoped pattern table (the four re-parse sites folded into one admittedNode,
	  a parse-count gate); variant-typed page slots, after FOLD's brands; fact identity as a text tuple in a TupleMap,
	  after FOLD's brands; every joined-text value key in the test models and write/family/draw.ts textsKey; then
	  scripts/dev/golden/* goes, with its .fallowrc.json entry and capture.ts's line in oxlint.config.ts.
	- Not code here: RDS IAM against a real RDS, a quiet-machine bench, the fallow upstream report, the PostgreSQL GA
	  repin date, the superstarter and edullm copies.

### 3. No example-based test
Owner 2026-11-06: example-based tests are banned. A test is an example when a person chose its inputs and wrote its
verdict. A hand list run through `exhaust` or `element` counts.

What stays:
- a property against an oracle, over generated inputs;
- an exhaustion of a box its bounds define;
- kept cases: shrunk counterexamples, replayed through their suite's own property;
- dictionaries a generator draws from: values the code branches on, never verdicts;
- the README's and SKILL.md's mirrors, which hold the docs to compiling code.

- **3.1 The rule.**
	- CONTRIBUTING's doctrine 2 drops its exemption ("Keep an example only for…") and states the ban.
	- grizzle's devtools oxlint plugin refuses a test case that is not a search (explore, exhaust, commands,
	  interleave, or a helper that runs one), and an `exhaust` over an array literal.
- **3.2 Inventory** (main, 2026-11-06). Each test case was traced through the helpers it calls. Of 1,463 cases, 357 run
  no search, in 135 files. Hand case tables also run inside searches in 16 more files. Wave 2's lanes, at most four at
  a time, each own their files' conversion:
	- **W-adapter:**
		- test/unit/adapter/** (reader 7, refresh 7, migrate 6, witness 5, transactions 3, bind, boundary);
		- admission/target;
		- pg reads/boundary, page/page (10 hand verdicts), serverless/vercel, world-model/execute,
		  direct-writers/isolation.
	- **W-cli:**
		- test/unit/cli/** (cli 15, check 3, generate-opens 2, literal-pack, markers, skill);
		- test/unit/deploy/** (backfill 6, ledger 2, render 2, folder);
		- physical/family-columns;
		- pg cli, migrate/renames, migrate/attnums, closed/fin-migrations.
	- **W-physical:**
		- physical/fin (11), physical/literal (7);
		- pg physical/* (install, checks, row-security, search-policy, world-serving), closed/codes, plans,
		  scalar/registry, compute/registry and aggregate, derived/install and workload-index, workload, vector/*,
		  lower-conservative and oracle-gen vocabulary, sql/print, recursion/graph/r37, program/templates,
		  laws/alternatives, lower-shapes/shapes;
		- the schedules fin/contention, fin/platform, install/database-default, worlds/fence.
	- **W-infra:**
		- the dependency audit (deps 10);
		- bench/harness (8);
		- dev/mutate (5), dev/package;
		- substrate (pg 5, cells 3, temporal 2, bits, fin, tree, unit 2);
		- kernel dict, message and assert;
		- fixtures-ir;
		- oracle-runner, pg/oracle/reference, spans/oracle/reference.
		- Each stays only if it guards a class of bugs nothing else catches, and becomes a search. The audit of the
		  real tree is itself an exhaustion and stays.
	- **W-types:** the type tier's 46 fixture files, after lane T. The generated population extends the existing
	  type/engine agreement (test/support/agreement/queries.ts, test/types/evidence/agreement.test.ts) from queries to
	  schemas, roles, ChangeSets, compute, fields, pages and derived relations.
	- **Kept as they are:**
		- the bench gates (test/pg/bench), which are performance properties;
		- the README and SKILL mirror (test/types/examples/blocks.test.ts).
	- **Out of grizzle's scope:** packages/testing's own tests (idioms 20, core 5, consumer 4, guard 3, and others).
	  The library is shared and changes in superstarter first (see After the beta).
	- **The lint rule of 3.1** goes into grizzle's devtools plugin, because the testing library's plugin is shared.
- **3.3 Replacement suites, by area, each named by its oracle.**
	- Refusals (check/semantics, check/reasons, check/head-literals, compute/text's invalid list):
		- a planted-fault generator draws a valid program from the query and write generators;
		- it applies one fault per CompileReasonTag, and every reason must be reached;
		- the checker refuses with exactly that reason and its fields, and admits the program without the fault.
	- Lowering (lower/dedup/verify and kin): arms of the differential oracle, each rewrite rule a required situation.
	  The examples go.
	- SQL text (sql/lexer): over generated ASTs, lexing what the printer printed gives back its tokens; plus an
	  exhaustive box of token boundaries.
	- Writes and families (write/changeset/value, physical/fin): arms of the write oracle and of the families model.
	- The command line (cli/*): a commands program over a generated project.
		- Its steps are: change the schema, generate, check, migrate.
		- A model of each command judges what it writes, its exit status and its refusal's tag.
	- Adapter reads (adapter/reader): the flight fuzzer's scripted session.
	- Catalog agreement: generated schemas, checked against the catalog verifier.
	- Tooling (bench/harness, deps, dev/mutate, dev/package, substrate, program/limits, workload, migrate/renames,
	  schedules/derived/refreshers): a test stays only for a class of bugs nothing else catches, and then becomes a
	  search. The rest are deleted.
	- Types: a generated type population replaces the fixtures.
		- Programs drawn from the schema, query and ChangeSet generators are printed as TypeScript and checked as one
		  batch.
		- The engine is the oracle: a program typechecks exactly when the engine compiles it, a refusal's
		  `Refusal<"…">` names the engine's reason, and an inferred row type equals the engine's decoded heading.
		- The negative fixtures go. The README and SKILL mirrors stay.
	- Test infrastructure, in the areas the lanes touch:
		- test/support/pg.ts types its parameters: ReadonlyArray<unknown> let an Identity reach a query;
		- every pg suite's raw setup goes through one attempt-and-observe helper, against 40001 under load;
		- education's candidate box draws claim fields jointly, and its whilePending gate reads its own requirements;
		- serving's 780-line kept case shrinks to its sketch, and the library learns to shrink from a kept case's draws.
- **3.4 Behaviour the README states that no test holds.** These are the old "Tests owed": claims, roles, logins,
  reading and writing through a world, read-backs, refusals, installation, drift, packaging, index use under roles, and
  the README clauses.
	- The inventory checks each one against the suite.
	- What is still owed becomes an arm or a required situation of the suites above, never an example.
- **3.5 Adequacy, which is also the deletion rule.**
	- One seeded `pnpm mutate` sample runs on the commit before wave 2 (the baseline), and the same sample runs on the
	  final commit. Both runs use scratch copies.
	- An example test is deleted in the commit whose new suite kills every mutant the example killed.
	- Every surviving mutant becomes a generator arm or a written equivalence, and triage.json is pruned to the final
	  code.

### 4. The release
- **The gate.** The whole gate runs on the release commit, on the pinned build:
	- `pnpm check`, then the unit and type tiers, then the pg tier at --maxWorkers=3 with a pinned TEST_SEED;
	- against a `git archive` of the commit, with its own install and an empty git repository;
	- each failure is rerun once, alone, and only a pure load timeout that then passes counts as a flake;
	- a real failure is fixed, and then the whole gate runs again.
- **Versions** go to 1.0.0-beta.1 in packages/engine and packages/grizzle.
- **CHANGELOG:** Unreleased becomes 1.0.0-beta.1 with its date and keeps its upgrade guide. It gains entries for #9 and
  for the empty-language refusal.
- **CONTRIBUTING's oracle paragraphs** name the new suites: the worlds rules suite and leak-scan property, the fill-order
  generator, the type/engine agreement populations, the startup call-count guard and `pnpm bench compile`, and the
  test-case lint rule.
- **README and SKILL.md match the release:**
	- the pinned PostgreSQL and its patches;
	- the limits the README doesn't state yet: a pattern whose language is empty is refused, a family's
	  member side can't be a selection, a side's terms must be distinct, a generated NOT NULL's 23502 names no law, and
	  `db.explain` drops index names;
	- the install line, for a first publish under the `beta` tag;
	- every changed ts block's mirror changes with it.
- **Tarballs:** `git archive` the release commit into ~/.cache/grizzle-release/, `pnpm install --frozen-lockfile
  --ignore-scripts`, then `pnpm pack` packages/engine, packages/grizzle and packages/testing (the last with
  `npm pkg set version=0.0.0` first). Pack twice and compare byte for byte. The release commit's full hash goes to the
  owner.
- **The owner publishes.** Main hands over one line that tags the release commit, pushes the tag and runs
  `pnpm -r publish` (grizzle's first publish: neither name is on npm). Main closes #9 with the fixing commit; no other
  announcement.
- **TODO:** this section is deleted, and the beta's follow-ups are listed below.

## After the beta
Owner 2026-11-06: no known bug or limitation is parked here. What stays is work outside this repository's code, or
not a defect.
- **fallow:** unused-class-member doesn't follow union narrowing, so check/params.ts ParamCell.use and useRelation need
  a usedClassMembers entry. Report it upstream, then drop the entry once fallow is fixed.
- **Test layout:** tests move into packages/*/test, with their mutate and fallow paths and the docs.
- **`bench:full` on a quiet machine.**
- **Sweeps under conflicting key orders,** the residues no plan avoids, which the serving judge excuses
  (test/pg/physical/serving.ts residueOf).
	- GiST's cost model is blind to column position: upstream/gist-costestimate-column-position, for PostgreSQL 20.
	- The partial B-tree sweep is PostgreSQL being right.
- **RDS IAM** against a real RDS.
- **Cross-repo, outside school hours for edullm:** grizzle's packages/testing differs from superstarter's in 43 files,
  though each repository's copy is meant to be byte-identical. Reconcile them, the library's searches-only tests and
  the test-case lint rule included. Then copy the library into edullm, with the no-spread-argument rule and the shared
  lint standard.
- **PostgreSQL 19 GA (2026-11-19):** repin. The relcache patch is rebased and kept until a release includes it.

## Upstream, for the owner to file
- upstream/plpgsql-lineno-rescan: PL/pgSQL rescans the source on every location-to-line lookup.
- upstream/gist-costestimate-column-position: a pgsql-hackers reply to BUG #15408, for PostgreSQL 20.
- upstream/relcache-planned-check-and-generation, written in section 1.
- upstream/tsgo-zero-cpu-stall: tsgo at 0% CPU on a type error, unreproduced so far. Reproduce it without the
  effect-tsgo patch first, then file at microsoft/TypeScript (typescript-go was archived on 2026-09-01).
