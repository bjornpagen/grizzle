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
- **A pattern whose anchors leave no match is admitted.** `^$a` is lowered to `\A\Za`.
	- Root cause: `LiveNode` (scalar/regex/ir.ts) claims a member, but the constructors make only an empty class
	  `never`, never contradictory anchors.
	- The same hole admits a `str.regex` past the DFA bounds whose language is empty, because text/refinement.ts
	  languageOf trusts the IR there.
	- Fix in the IR:
		- each node carries the set of its paths' profiles, in one byte;
		- a profile is three bits: it consumes a character, it passes `^`, it passes `$`;
		- a sequence keeps a pair of profiles unless a character comes before a `^` or after a `$`;
		- an alternation takes the union of its arms' profiles, and a repetition closes over copies of its body;
		- a node with no profile left is `never`.
	- This is exact for the admitted grammar, and linear. The flags are only u and su, so `^` and `$` anchor the string;
	  there is no lookaround; and every class is non-empty over admitted text.
	- After the fix:
		- admit.ts matchPattern and refinement.ts are exact as written;
		- languageOf's DFA-empty branch can't be reached and is deleted, with isEmptyLanguage if nothing else reads it;
		- the `never` tests in translate.ts, whitespace.ts and source.ts become exact too.
	- Test: the escaped bug is the generator's, since test/unit/compute/text.test.ts draws one empty pattern, `[]`.
		- A property over patternOver, whose anchors fall anywhere: the IR is `never` exactly when a search of its NFA
		  finds no accepting path. The search follows walk's rules: a `^` only before the first code point, nothing after
		  a `$`.
		- The situation "empty through an anchor" is required, so the witnesses reach it on every seed.
		- matchPattern and analyzeText refuse exactly those patterns, each with its reason.
	- Planted bug: the constructors go back to class-only emptiness, and the property fails on every seed.
	- CHANGELOG: such a pattern is refused at compile time, in `Compute.matches` and `str.regex` alike.
- **A generic call re-instantiates the whole schema type.** Every generic call on a Rule, Query or ChangeSet walks S's
  statement tuple, about 7 instantiations per statement, because S's object-literal field records hide that S has no
  type variable. A query therefore costs time linear in the schema's statements, not in what it reads: the query
  budget grows 3.77× per doubling of schema and programs together.
	- Fix by representation: the schema type stops carrying the statement tuple as a type argument the checker walks.
	  It keeps its statements by name, with literal relation names, and StatementsOf<S> rebuilds each one's full type.
	- Owner's rule: no loss of public precision. `typeof S.statements` must stay as precise as it is. If no
	  representation keeps it, record that and leave the tuple.
	- Gate: the query budget's increment ratio under 3 in each dimension.
- **One meaning, two laws.** The reported selection collision does not reproduce: every law kind over two selections of
  one relation gets distinct ids and names (lane L, 2026-11-06). The converse is a defect: own.ts canonicalPredicate
  keeps a comparison's operand order, so `eq(a, b)` and `eq(b, a)`, or `lt(a, b)` and `gt(b, a)`, are two laws with
  two generated columns and two foreign keys.
	- Fix: a symmetric comparison orders its operands canonically, and gt and ge become lt and le, swapped.
	- A generated arm requires "two laws over selections of one relation" and "a comparison stated in both
	  orientations".
- **Startup cost is a hard blocker** (owner's ruling, relayed by the downstream session 2026-11-06: "clean and cull
  away, hard delete all the code that is now dead or pointless … hard blocker for next beta").
	- A downstream login's DbLayer build takes 194 s, where it took 7.35 s before the cutover, and `grizzle check`
	  takes 320 s on its schema.
	- The fix is deleting work, not tuning it, and no hidden memo.
	- **The DFA byte bound, rebuilt for every key datum** (41%): textByteBound → patternByteBound → analyzeText →
	  minimalDfa runs at every key and axis a text column rides (keyDatums, plannedDatum, #refuseWideRows). A field's
	  refinement is analyzed once, when its description is admitted, and the analyzed refinement (its bounds and key)
	  travels with the descriptor, so every later reader reads it.
	- **migrate and drift compile everything they discard:** resolveConfig (cli/run.ts) compiles every schema, login
	  and workload for every command. A command that applies committed SQL reads the configuration's names,
	  identifiers and directories, and compiles nothing.
	- **The schema's canonical encoding, more than once** (20%: levelSchema, levelOf, sameDesc, descText); see the
	  next item.
	- Then profile a large schema's DbLayer.make, role() and check, and delete every whole-schema pass that runs twice
	  or whose result nothing reads.
	- Acceptance: a generated large-schema bench of DbLayer.make, check and migrate, at n and 2n. The downstream
	  session measures its own layer build against 7.35 s, with migrate compiling nothing before it connects. Send it
	  each landing commit's hash.
- **Every login re-encodes the whole schema twice,** closed-relation rows included. login() spends about 450 ms
  re-encoding a schema with one 20,000-handle closed relation, and a downstream import spends 41% of its time there.
	- Sites: login's `sameDesc(desc.base, baseDesc)` (two full encodes per role), role's
	  `identity: descText(roleDesc)` (which re-encodes the base), and levels.ts isLevelOf's identity shortcut with an
	  encode fallback.
	- Fix: each schema value carries a content digest (SHA-256 of its encoding without level names), computed once in
	  schema() and extend(). A role's identity is its own part plus the base's digest. login and isLevelOf compare
	  digests, and the shortcut and its fallback are deleted.
	- Measured at n and 2n relations, with a large closed relation, before and after.
- **GG's whole-suite run at 99b6217** (TEST_SEED=20261106, --maxWorkers=3, load 20–30). pnpm check and the unit and
  type tiers pass. 8 pg files failed, and failed again alone. Classified by the downstream session:
	- **Engine defects:**
		- lcm over numerics with fraction digits: scalar/compute/lower.ts bounds its integer digits as `da + db`.
		  The bound must count the fraction digits (`da + db + max(sa, sb)`), derived and proved, not patched. The
		  strict reader refuses the value (pg/compute/catalogue, 40 disagreements). The catalogue's generator must
		  draw fractional lcm operands on its floor stream.
		- An attached `orderBy(...).take(k)` arrives ordered by the parent key then the id, not by its order
		  (R20, bench/query/take.bench.ts). A take stage returns `order: undefined` (check/checker.ts), attachIn
		  substitutes the empty order, and completion adds only the child's key. This contradicts README's attached
		  take. A generated attach suite asserts the delivered order of every attached take.
	- **Stale since closed ids became smallint codes,** in tests and benches:
		- pg/oracle/union-take's expected rows spell handles;
		- pg/program/templates' raw INSERT writes handle text;
		- bench/query/access's and union's handwritten SQL selects handles (R21 compares digests).
		- Each reads codes through the naming door, or is restated as a property.
	- **Bench and test support:**
		- claim.bench.ts seeds the alternatives' native deferred FK in autocommit statements; seed in one transaction;
		- events.bench.ts fills the Member/Grp cycle in two autocommits;
		- families.bench.ts records no timed phase;
		- laws.bench.ts schema-qualifies a multi-argument unnest (test/support/sql.ts), which PostgreSQL rewrites into
		  ROWS FROM only when unqualified.
	- **Generator:** pg/oracle/optimized/generated-2: gen/query.ts's literal fallback types 10 at a numeric bounded
	  to one digit, and gen/domain.ts valueClasses ignores the bound.
	- **To settle on 5433:**
		- pg/recursion/oracle/fixed-length hits a 57014 statement timeout on a tiny case under forced parallel plans.
		  The 30 s guard (test/support/oracle/runner.ts) is a bare constant, not a Limit. Replay
		  `recursion/fixed-length:-:0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.1.0.0.0.0.4.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0`
		  alone, reading parallel_workers_launched and EXPLAIN ANALYZE.
		- pg/oracle/optimized/generated-1 runs out of the JavaScript heap (about 3.9 GB). Whole results are buffered
		  across every lowering. Rule out a dropped DISTINCT first.

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
	- **W-write:**
		- test/unit/write/** (changeset/value 21, owner 10, normalize 3, delta 2, insert/unique 2, put/program 2,
		  refusal 2, fills, unstated-key, changeset/scaling);
		- test/pg/write/refusal;
		- test/unit/history/check's 8 hand verdicts.
	- **W-lower:**
		- lower/dedup/verify (24), lower/shapes/relparam, lower/rewrite/closed;
		- ir/shape, ir/dag, ir/desc;
		- sql/lexer, sql/audit, sql/rows;
		- codec/recordset;
		- core/limits, core/lines;
		- derived/keys, allen/mask, program/limits, laws/model.
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
