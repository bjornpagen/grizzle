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
- Waves:
	- wave 1 is lanes P (section 1), R (the regex fix) and T (the type layer), with main taking the test inventory;
	- wave 2 is the test areas of 3.3, at most four lanes at a time;
	- wave 3 is the release (section 4).

### 0. Housekeeping
- ~/Documents/grizzle-proposals: issues #1–#8 are closed and #9's design (fallible operations total) has landed.
  Look at each file once more, then delete the folder.
- ~/Documents/postgres-upstream-submissions predates upstream/. Move anything newer into upstream/, then delete it.
  Its recursive-union and btree_gist folders are upstream already.

### 1. The PostgreSQL build keeps only what is required
- **Delete plpgsql_check.**
	- Why: its one use is the coverage cluster's profiler, a measurement no gate reads. Its 2.10.15 profiler also PANICs
	  a COMMIT once 20,000 functions are profiled (profiler.c:102, :1335).
	- What goes:
		- pin.env's five PLPGSQL_CHECK_* lines;
		- build.sh's fetch, build and stamp;
		- lib.sh's stamp and the coverage cluster (use_cluster, PG_CLUSTERS);
		- init.sh's --coverage block;
		- doctor.sh's --coverage checks and its profiler probe;
		- ctl.sh's --coverage;
		- scripts/dev/plpgsql-coverage.ts;
		- package.json's `pg:coverage` and `plpgsql-coverage`;
		- test/support/env.ts's PgCluster and GRIZZLE_PG_CLUSTER;
		- pg-global-setup.ts's coverage report;
		- CONTRIBUTING's coverage-cluster paragraph, its `pnpm plpgsql-coverage` row and every --coverage mention;
		- ~/.cache/grizzle/src/plpgsql_check-*.
	- The superuser connection every pg test uses (test/support/substrate/substrate.ts) stays. Rename its
	  coverageAdminUrl to adminUrl.
	- grizzle keeps one copy of PostgreSQL. The coverage copy (5435) is already deleted, so its scripts go with
	  plpgsql_check: there is no second cluster in pin.env, lib.sh, init.sh, ctl.sh, doctor.sh or build.sh.
- **Delete 19rc1-btree-gist-multibyte-penalty.patch.**
	- It is performance only, and already upstream (master b82d69abf6), so grizzle has nothing to submit. No test reads
	  it.
	- README's known issue stays, stated for stock PostgreSQL, without the patch sentence.
- **Keep 19rc1-relcache-planned-check-and-generation.patch.**
	- It is grizzle's own, valuable and upstreamable: every CHECK and generated field that reads a closed relation's
	  constant pays for it on every statement without it.
	- Rename it for RC2 and apply it with no fuzz.
	- Write its submission into upstream/relcache-planned-check-and-generation/ in the shape of the other two: the patch
	  on master, a repro, evidence, an email and a checklist. The owner files it.
- **Repin to 19rc2 on 2026-11-12, if the beta isn't out by then:** pin.env, rebuild, re-init, then delete the 19rc1
  build, source and cluster.
	- RC2 includes the recursive-UNION hash_mem fix, so that patch goes.
	- After the repin, confirm the two RC2 fixes that touch grizzle:
		- DROP DATABASE … WITH (FORCE) beside parallel autovacuum workers (the sweep runs it);
		- the RI fast path with a cast (grizzle pairs FK columns of identical types).
- **Rebuild 19rc1 now** (owner 2026-11-06: recompile is fine), once GG's run on 5433 has ended: `pnpm pg:build`
  stops the cluster, swaps in the build without plpgsql_check and the btree_gist patch, and starts it again.
- README's PostgreSQL statement names the patches the build applies. Update CONTRIBUTING's pg:build and pg:init lines
  to match.

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
- **Issue #9: `ChangeSet.empty(role)` and `query(role)` fail with TS2589** once base laws × role entries pass about
  1.2 million.
	- Root cause: types/schema/world.ts KeptStatement checks each base law's relations against the union of every whole
	  entry (`[NamedBy<St>] extends [Whole]`). So a role's `statements` costs laws × entries, and `S extends AnySchema`
	  reads it.
	- FullBaseOf has the same shape: an Exclude of every base relation against the union of the entries.
	- Fix by representation: a role's relations are its index by name, as a schema's are.
		- A law is kept when each relation it names is the role's entry under that name: one lookup per relation.
		- The full base is a mapped check over the base's record.
	- Close #9 with a comment naming the commit.
- **The type layer's cost grows linearly in every schema dimension.**
	- Owner 2026-11-06: efficient, typechecker-safe types. No `as`, no `any`, no ts directive, no widened fallback, no
	  dropped refusal and no raised limit. Precision is kept.
	- Scaling programs, one per dimension, each checked at n, 2n and 4n:
		- relations, laws per relation, role entries, roles per schema and fields per relation;
		- query rules and attachments, ChangeSet members and contexts;
		- they extend test/types/schema/budget and test/types/query/budget.
	- Gate:
		- every program typechecks with no diagnostic at sizes past #9's cliff;
		- Types and Instantiations grow linearly: an increment ratio under 3, read as families.test.ts reads it.
	- Check time is not gated: tsgo reports no relation-cache counter, and time under load is noise. But the families
	  suite's check time triples per doubling while its instantiations only double. Profile tsgo's check at the largest
	  size and fix every superlinear site, union-against-union relations first.
	- Audit every distributive conditional over a schema-sized union, and every mapped type evaluated again per element.
	  By file: query.ts 10, evidence.ts 7, changeset.ts 5, schema.ts 3, world.ts 2, terms.ts 2, and one each in rule,
	  regex, derived, workload and phantom.
- **A law's identity drops a side's selection,** so two laws over selections of one relation can share a name.
	- Verify with a generated pair of such laws. If they share an installed name, it is a naming-door bug: the identity
	  takes the selection, and the pair installs under distinct names.
- **`role(...)` took 2.0 s and 271 MB over 137 relations** (measured 2026-11-06, at load 27).
	- Measure the description's construction at n and 2n relations. If it grows faster than linearly, it is a bug of
	  #9's family, fixed by the same index.
- **GG's whole-suite run at 99b6217.**
	- Every real failure in it is fixed at its root.
	- It also settles the four suspects: the unit tests lower/conservative/parameter-refined, analysis/logical/evidence
	  and compute/text, and the pg test recursion/oracle/fixed-length.

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
	- The testing library's oxlint plugin refuses a test case that is not a search (explore, exhaust, commands,
	  interleave), and an `exhaust` over an array literal. The rule lands in superstarter's packages/testing first and is
	  copied, as every library change is.
- **3.2 Inventory, by main, written into this file.** Every test file is classed keep, convert or delete, with the class
  of bug that only it catches. Found so far, across 565 test files:
	- 34 files run no search (101 cases);
	- 19 files carry hand tables of inputs and verdicts: check/semantics 33, lower/dedup/verify 24, check/reasons 15,
	  sql/lexer 6, and others;
	- 95 files draw `element` or `exhaust` over 219 literal lists, each of which is a dictionary or a case list;
	- some files have more cases than searches: write/changeset/value, cli/cli, physical/fin, deps, catalog/agreement,
	  bench/harness, adapter/reader;
	- the type tier has 46 fixture files: 12,836 lines with 775 `@ts-expect-error`.
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
	- A baseline `pnpm mutate` runs over each area's files before the area's lane starts, and again after it lands.
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
- **Cross-repo, outside school hours for edullm:** grizzle's packages/testing differs from superstarter's in 43 files,
  though each repository's copy is meant to be byte-identical. Reconcile them. Then copy the library into edullm, with
  the no-spread-argument rule and the shared lint standard.
- **PostgreSQL 19 GA (2026-11-19):** repin. The relcache patch is rebased and kept until a release includes it.

## Upstream, for the owner to file
- upstream/plpgsql-lineno-rescan: PL/pgSQL rescans the source on every location-to-line lookup.
- upstream/gist-costestimate-column-position: a pgsql-hackers reply to BUG #15408, for PostgreSQL 20.
- upstream/relcache-planned-check-and-generation, written in section 1.
