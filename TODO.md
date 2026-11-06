# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## Now: the second beta, 1.0.0-beta.1

Owner 2026-11-06: everything in this section lands before the beta, in this order. The PostgreSQL build keeps only
what grizzle needs, no bug is known, no test is an example, and the type checker's cost grows linearly in every schema
dimension.

How the work runs:
- Owner 2026-11-06: approved; work autonomously to the end, deciding along the way, and hand the owner the one-line
  publish command. The test inventory (3.2) is written into this file, and wave 2 starts from it.
- Main reads the code and the tests itself and integrates. At most four coding lanes run at once, in the main checkout,
  on main, with no branches. Lanes write code only: no repository typecheck, no test runs, no git. A lane may check a
  standalone program of its own under ~/.cache/grizzle-release/, such as a type-cost probe.
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
- **Hex is the one way grizzle serializes bit data** (owner's ruling 2026-11-06, relayed: "the bit string arithmetic
  is forbidden … the only way we serialize the bitset stuff is hex … never two ways of doing the same thing").
	- Closed constants: the rows form (string_agg of 0/1 cells in a DO block) and the `{ pack }` option are deleted.
	  Every constant is its hex literal under its comment of row count and content digest, which `grizzle check`
	  decodes and holds to the digest. README :1403 and :2553-2559 change with it. Density is the user's lever (denser
	  coordinates); no size escape hatch.
	- Every bit(n) and varbit literal grizzle emits is hex, a set CHECK's empty set included. A width that isn't a
	  multiple of 4 gets one defined form, decided by the lane. One form either way.
	- Anything else that writes bits as text: bits parameters on the wire, meta.json and snapshot.json, diagnostics.
	  One spelling wherever grizzle chooses one.
	- Test: a generator of closed relations (every arity, density, payload width) and of bits fields and set literals.
	  Oracles:
		- every bit literal in every drafted file is hex, and the rows spelling never appears;
		- decode(encode(rows)) = rows;
		- `grizzle check` refuses any flipped digit.
	- Planted bug: the rows form re-enabled for one relation.
	- physical/ddl/constants.ts planClosed builds per-cell display names (a canonical encode per cell) that only the
	  rows form's comments read, and DbLayer.make pays for them. They go with the rows form.
- **Key text is bounded by bytes** (owner's ruling, relayed by the downstream session 2026-11-06; hard cutover, chosen
  over digest keys). Lane K, goal 2.
	- `Compute.octetLength(text)` lowers to `octet_length`, returns an integer, and stands in a contract's check as
	  `charLength` does.
	- textByteBound reads it as an exact byte bound: <=, <, =, between, in, their mirrors and conjunctions. With
	  charLength too, the bound is the min of charLength × 4 and the octet bound.
	- `UnrepresentableKey` names the byte bound it found.
	- One public function in grizzle's terms gives the most bytes a text can hold beside given fields in one B-tree
	  entry. No consumer re-spells PostgreSQL's page constants.
	- Exact padding through a key's fixed-width prefix only if provably sound.
	- Tests:
		- the bound per predicate form, generated;
		- on the cluster, an octet-bounded key at exactly N bytes inserts and N + 1 is refused by the domain CHECK;
		- multibyte values at the boundary.
	- Planted bugs: the octetLength reading dropped, and an off-by-one in the budget.
	- Send the landing commit's full hash to the downstream session.
- **A generic call re-instantiates the whole schema type.** Every generic call on a Rule, Query or ChangeSet walks S's
  statement tuple, about 7 instantiations per statement, because S's object-literal field records hide that S has no
  type variable. A query therefore costs time linear in the schema's statements, not in what it reads: the query
  budget grows 3.77× per doubling of schema and programs together.
	- Fix by representation: the schema type stops carrying the statement tuple as a type argument the checker walks.
	  It keeps its statements by name, with literal relation names, and StatementsOf<S> rebuilds each one's full type.
	- Owner's rule: no loss of public precision. `typeof S.statements` must stay as precise as it is. If no
	  representation keeps it, record that and leave the tuple.
	- Gate: the query budget's increment ratio under 3 in each dimension.
- **Startup cost is a hard blocker:** lane PERF's cut is in the tree, and lane K's (one analysis per pattern) is coming.
  At 150 relations with 20k + 200k closed rows, in CPU time:
	- check 81.3 → 11.8 s;
	- DbLayer.make 43.7 → 8.0 s;
	- migrate before connecting 70.3 → 0.93 s, compiling nothing;
	- workload() 12,980 → 30 ms.
	- Each grows linearly at 2×.
	- The guard is test/unit/startup/work.test.ts, exact call counts through test/support/kernel/calls.ts, and the bench
	  is `pnpm bench compile`.
	- Left: closed admission (next item), and planClosed's per-cell names (the hex item).
- **A closed relation's cells are re-validated at every compile** (lane PERF, after lane K's ir/desc.ts edit is
  committed): SchemaDesc's closedRelation arm is a plain RelationDesc, so analysis/schema.ts #closedInfo re-admits
  every cell, a roster handle by a linear scan (cells × handles).
	- Fix: every decoded SchemaDesc's closedRelation arm is an AdmittedClosedRelation, minted only by
	  closed.relation() and one schema-level audit in decodeDesc. #closedInfo converts admitted rows without
	  validating, own.ts #checkClosedRows goes, and the fixture builders mint through admission.
- **A role lacks EXECUTE on functions a write reaches through a cast** (blocking every downstream write, proven on the
  cluster, 2026-11-06).
	- A role's insert fails with 42501 on a roster's `_live_` function: the roster's bits domain appears only as a
	  cast inside a CHECK.
	- physical/ddl/roles.ts roleExecutes gathers the calls of the column-typing domains, the written tables and the
	  views, and context.ts callsOf collects only functionRef nodes, so a cast to a domain never pulls in that domain's
	  CHECK.
	- Fix: one reachability over the DDL graph through functions and domains (column domains; casts in CHECKs,
	  generated columns and defaults; domain CHECKs and contract base chains; constant bodies), granting exactly that.
	  USAGE is checked for the same hole.
	- Test: generated schemas with roles and drawn write lists.
		- Oracle 1: granted = reachable, computed independently.
		- Oracle 2, on the cluster: each written table's first generated insert raises no 42501, and
		  has_function_privilege agrees.
	- Planted bug: the cast traversal dropped.
- **Generate accepts what the first write refuses: the class** (blocking; owner's ruling 2026-11-06: deep fix, brutal
  test). Every write refusal that depends on the schema alone is decided when the schema compiles. Known instances:
	- the unfillable copy (below);
	- a tree that owns an ordered family: write/family/nesting.ts nestingOf refuses the family met again through the
	  tree's own recursion, though depth-first order is defined;
	- a unique key over a generated field: write/frontend/compile.ts refuseGeneratedUnique refuses every addition, and
	  generate accepts the schema.
	- The class guard is lane W-fill's bidirectional property over a generator that includes all three shapes.
- **A schema that generates but whose writes can never compile** (blocking, owner's ruling 2026-11-06: deep fix,
  brutal test).
	- The downstream schema passes generate, check and migrate, but every ChangeSet.insert of its role is refused:
	  `UnsupportedOperation … BranchResolution.instanceEnd copies Instance's end along the owner axis of
	  Instance.rules, a column its owner fills only after its members` (write/family/fold.ts `unfillable`).
	- The member is a counted family over a tree's owner, copying the owner's `end`, a leaving column, through a
	  containment.
	- Fix: the law model refuses an unfillable copy when the schema compiles, a named refusal on the field and the law,
	  so generate and check never accept a schema no write compiles. README "How a field is written" states the rule.
	- Test:
		- a schema generator over relations, trees, counted and ordered families, folds, and containments copying
		  entering columns, leaving columns and fold ends along owner and predecessor axes;
		- swarm weights per run, and each shape exhausted to a small scope;
		- oracle: generate accepts ⇔ every write program of every login compiles, and on the cluster a generated
		  instance's first insert succeeds.
	- Planted bug: the compile-time check removed.
- **Census items from the downstream session** (2026-11-06), still open:
	- the containment UNIQUE escaping the entry bound (lane K, goal 3);
	- README states the str.regex grammar (no lookaround, no \p), and that a generated NOT NULL column's 23502 fails
	  the write as ExecutionFailure naming no law.
- **A query ending in `orderBy(...).take(k)` is delivered in that order, root or attached** (decided here, one rule).
  The attached case is done (StageOrder `delivered`). A root query ending in a take is still delivered as a set, while
  README :138 pairs it with Drizzle's ordered `.orderBy(...).limit(10)`. Make the root follow the same rule, with a
  generated differential arm and the planted bug of the root dropping the order.
- **Bare statement-timeout guards in tests** remain in test/pg/oracle/optimized/support.ts, page/generated.ts,
  payroll, recursion/graph and text/differential. No verdict rests on the clock (doctrine 6), and the case hang guard
  stops a hung case, so delete them, as test/support/oracle/runner.ts's was.
- **To settle on 5433 at the gate** (W-gg's investigations):
	- recursion/oracle/fixed-length's 57014: the hypothesis is a Gather on the inner side of a nested loop over the
	  recursive term, under the perturbation's hash and merge joins off, relaunching workers per work-table row. Replay
	  the token and read pg_stat_database parallel_workers_launched before and after, with EXPLAIN (ANALYZE, VERBOSE,
	  SETTINGS). If confirmed, the perturbation stops drawing that combination.
	- optimized/generated-1's heap: OptimizedRun now keeps a form's rows only when they differ. Measure each form's
	  statements with count(*), count(DISTINCT t) and sum(octet_length(t::text)). compareRuns still re-reads the
	  baseline's rows for every form.
	- test/pg/program/templates is still an example test (W-physical).

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
	- **W-worlds** (W-write's remainder): in the worlds model (test/support/worlds), entries over a mutable relation
	  with a span key and over a pure set, every law family meeting an entry write, drawn read-back versions
	  classified against a host restatement, every law family's refusal raised by a partial role, and an owner keyed
	  WITHOUT OVERLAPS put in place (the write commands machine can't parse spans yet).
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
- **Representation-first follow-ups.** Once they are done, scripts/dev/golden/* goes, with its .fallowrc.json entry and
  capture.ts's line in oxlint.config.ts's no-dynamic-imports block.
	- Regex membership without the one named site: DAG headings and expression types carry resolved types IR-wide.
	- An analysis field on the IR's Attach node, projected out of the digest as Delta keys are. The lowerings then read
	  the analyzed facts instead of matching three DAGs by Attach id.
	- Variant-typed page slots and a total size encoder (pageBinding), carried through the page compile, the kits,
	  Delivery<Own> and the shell.
	- install/comments.ts mintedName: SQL AST names carry identities.
	- ir/scalar-shape.ts sameOptional compares by canonical text, until ExprTable has structural equality.
	- scalar/values/identity.ts builds row-identity strings as Map keys.
	- gen/query.ts's #canFail and #stable side tables fold into typed generator terms.
	- The oracle's value-identity string keys become structural identity, if a native structural map ever beats them.
- **fallow:** unused-class-member doesn't follow union narrowing, so check/params.ts ParamCell.use and useRelation need
  a usedClassMembers entry. Report it upstream, then drop the entry once fallow is fixed.
- **Test layout:** tests move into packages/*/test, with their mutate and fallow paths and the docs.
- **Engine exports:** narrow the engine's internal exports to compiled outputs: the read plan, the change plan, the
  migration plan and the expected catalog.
- **Keys:**
	- lowering rewrites' key claims rest on certificates, not KeyProofs;
	- a projection drops a dependency whose determinants include a column it drops;
	- a lateral source column fixed to a region column gives only one direction;
	- k joined relations with two declared keys each still give 2^k minimal keys;
	- a closed relation's identical-valued columns aren't detected as one class.
- **A counted family member that is also a sequence member, a tree or a sequence owner:** README promised it, but the
  writer never supported it. From the beta on, the schema compile refuses it (UnwritableRelation countedAndSequence).
  Writing it means one fill order that interleaves the counted edit and the sequence walk.
- **Typed terms:** a CheckedExpr brand with per-level constructors, at about 40 builder sites.
- **Performance:**
	- A guarded float form costs a SubPlan per row (lower/conservative/expr/total.ts bindOperands). Bind the operands
	  once per row with a LATERAL, behind a float-sum gate written first.
	- Performance under roles: the 1M-row plan suites read through world views and row security, every read
	  index-served.
	- `bench:full` on a quiet machine.
- **Sweeps under conflicting key orders,** the residues no plan avoids, which the serving judge excuses
  (test/pg/physical/serving.ts residueOf).
	- GiST's cost model is blind to column position: upstream/gist-costestimate-column-position, for PostgreSQL 20.
	- The partial B-tree sweep is PostgreSQL being right.
- **The beta's open items:**
	- `date` has no span carrier;
	- a relation parameter whose pattern no stored column carries can't be delivered;
	- witness a CHECK refusal on the host;
	- order a family statement's rows by their pattern input, for PostgreSQL's 32-regex cache;
	- make Written and AdditionIn public;
	- run RDS IAM against RDS.
- **The testing library:**
	- A synchronous runaway (a backtracking RegExp, a pure loop) blocks the case's hang guard and Vitest's timeout
	  alike. Decide whether property cases run in a terminable worker, or document that the code under test bounds its
	  own work.
	- The type batch's tsc stalled at 0% CPU on a type error. Reproduce it, report it upstream, and make the batch fail
	  closed on a stall.
- **The testing library's own example tests** (packages/testing/src: idioms, core, consumer, guard, blocking,
  adapter and others) are converted in superstarter first, then copied, together with the test-case lint rule.
- **Cross-repo, outside school hours for edullm:** grizzle's packages/testing differs from superstarter's in 43 files,
  though each repository's copy is meant to be byte-identical. Reconcile them. Then copy the library into edullm, with
  the no-spread-argument rule and the shared lint standard.
- **PostgreSQL 19 GA (2026-11-19):** repin. The relcache patch is rebased and kept until a release includes it.

## Upstream, for the owner to file
- upstream/plpgsql-lineno-rescan: PL/pgSQL rescans the source on every location-to-line lookup.
- upstream/gist-costestimate-column-position: a pgsql-hackers reply to BUG #15408, for PostgreSQL 20.
- upstream/relcache-planned-check-and-generation, written in section 1.
