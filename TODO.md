# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## Now, in order
1. **Issues #1–#8, plus #9 (fallible operations total): hard cutovers, from first principles.** Designs in ~/Documents/grizzle-proposals/issue-N-*.md, which are deleted once their issue's change lands. Each design's §11 is its never-again plan: what the types make unrepresentable, the search fix, and the original bug planted at landing, which its suites must kill on every seed. No compatibility path anywhere: no old reader, alias, shim, flag or transition. Byte-identical output is never a constraint. Every snapshot, meta.json, golden and fixture is regenerated, and every database installed before the cutover is re-created. Owner 2026-11-03: swarm, one lane per bug (1–9), all at once in the main checkout, with no branches or worktrees. Lanes code only, with no typecheck, tests or git writes. The waves below are the sequencing inside the swarm. Main typechecks the integrated tree and commits it; then every test runs together, once all fixes are in, never one suite at a time. Push when green. No beta release.
	- **W0, alone (#6): one text representation.** Nothing else runs, because it touches every area.
		- every multi-line text goes into one append-only `Lines` sink (core/lines.ts): statements, migration files, snapshot.json, meta.json;
		- PERFORM's query is a core, and `and`/`or`/`row` take NonEmpty;
		- every non-tuple spread argument goes (codemod, about 230 files). The two in packages/testing (mutants.ts, pattern.ts) land in superstarter first and are copied, as every library change is;
		- superlint `no-spread-argument`, extended to `.apply` and `Reflect.apply` with non-tuple arrays, with `eslint/prefer-spread` in REJECTED, lands in superstarter and grizzle. edullm's copy and the shared lint SPEC wait for item 2;
		- `Installation.sql` is deleted;
		- the JavaScript string cap becomes a `ResourceBound` refusal, with a README Limits line.
	- **Main, beside W1 and W2 (#5 §11.6):** profile PL/pgSQL's quadratic CASE compile (pl_scanner.c location_lineno_init rescans) on the pinned cluster. Write the patch or bug report, the repro and the evidence into ~/Documents/postgres-upstream-submissions/plpgsql-lineno-rescan/. The owner files it upstream by hand.
	- **W1, four lanes:**
		- **S, SQL AST** (owns ast.ts, build.ts, print.ts, form.ts and transform.ts, plus verify/sql.ts, audit/operators.ts, kernel sqlgen/shape and mutants/ast.ts):
			- #4: absolute names. Builtins print `"pg_catalog".…`, carriers `"pg_temp".…`, one spelling for a qualified name (`printObjectName`), structural `sameTypeRef` in place of every `printType` comparison, and a `TypeSchema` brand so no `named` type sits in pg_catalog. Plus the catalog-read AST (sql/catalog.ts), and PL/pgSQL select-into, execute and DO nodes;
			- #2: PostgreSQL's empty spellings at the boundary: SelectCore is a union over distinctness, VALUES and DISTINCT ON take NonEmpty, empty alias lists and recordsets;
			- #5: `whenAbsent`;
			- a placeholder node replaces render/sql.ts's `text.replace(printed, placeholderToken)`, and `ColumnDef.default` is deleted (#4).
		- **T, testing library (#1):** lands in superstarter packages/testing first, then is copied to grizzle. edullm's copy waits for item 2.
			- witness phases (floor, a floor-seeded steered phase, exhaustion) are the only ones that decide requirements, stalls and kills;
			- the rotating stream is the sample, and the sample alone feeds the residual;
			- branded streams; steering is part of the requirement declaration;
			- `Reach.miss`, the reach table and `reachMargin` are deleted.
		- **R, renames (#8):** deploy/diff, deploy/render, the meta boundary and cli/check.
			- the candidate tree, with path ids instead of counters;
			- meta.json records every drafted statement under its owner, through `decisionRecord`'s proof;
			- the text attribution, `witnessesOf` and the defect are deleted.
		- **Q, query constants (#7):**
			- a term carries its domain and its values; heads read values, bindings and joins read domains;
			- `r.literal` is deleted, and `Compute.literal` refuses a roster, so `X.handle(m)` is the one roster constant.
	- **W2, four lanes on W1's AST:**
		- **N, names and drift (#4):**
			- every SQL text grizzle sends is printed by the engine. The adapter's catalog reads (roles, drift, expectation, admit, apply, ledger) become catalog-read ASTs (sql/catalog.ts, built by S), and the DO blocks become PL/pgSQL ASTs;
			- the wire takes only `EmittedText` or `MigrationText`;
			- regclass becomes an expression node;
			- one constant search_path;
			- drift gets an `unchecked` stage with true fix lines;
			- the lint rules `brands-sole-mint` and `no-raw-sql`.
			- N owns adapter/boundary/sql.ts and drift.ts; L messages N for its decoder changes.
		- **L, laws (#5):**
			- one deferred trigger and one function per (table, event), with the change test and row guards in its `WHEN`;
			- an exhaustive roster CASE, where each handle is armed or unarmed;
			- an UPDATE is checked as delete-old plus insert-new;
			- the law digest covers the family's details;
			- evidence and physical objects per unit;
			- snapshot.json holds DDL trees, one statement per line.
		- **W, writes (#2):**
			- the readers and the checker are total over headings, and the relation-parameter rule moves to the builder, decoder and types;
			- a serial class is a per-target variant, and each fact is classed once;
			- the `defaults` path and the described-member refusal are deleted.
		- **V, values (#3):**
			- Decimal is value-only, and scale-reading catalogue entries take operands through `trim_scale`;
			- float aggregates are order-independent;
			- every text-identity gate (`printsAlike`, `spelledAlike`, the spelling restrictions) is deleted.
			- then **F, fallible operations total (#9)**, in the same lane after V lands (both own scalar/compute):
				- `Failure`/`canFail` deleted;
				- every overload declares a `Totality`: exact integer and money arithmetic (`bigint`, `Money`), IEEE 754 floats, preconditions proven by bounds or a `Compute.cond` guard, else `PartialOperation`;
				- bare numeric bounded at 1,000 integer digits;
				- the role-entry restriction and the oracle's error frontier deleted.
	- **W3, tests, by area:**
		- #1's codemod over test/: every requirement declares its steering;
		- each proposal's generator arms, properties, mutation operators and deletions (§7), and its never-again additions (§11):
			- #1: replay fidelity and the clock bans;
			- #2: the entry exhaust box and empty-list weights;
			- #3: invariance relations, named reference declines and `world-reads-flip`;
			- #4: the ambient-session arm and a catalog-built dictionary;
			- #5: the class-wide scaling relation, digest injectivity and the pl_scanner upstream patch;
			- #6: the small-stack project, the recursion inventory and the limits arm;
			- #7: admission agreement and order invariance;
			- #8: the migration exhaust box and rename histories as commands;
			- #9: the boundary arm, refusal agreement and `world-precondition-drop`;
		- test/pg/migrate/renames.test.ts's FeaturesUnreached: #8's relations-box arm, under #1's witness verdict.
	- **Gate:**
		- typecheck once, fix, then typecheck once more;
		- regenerate fixtures and re-create the dev databases;
		- `pnpm check`, `pnpm test`, `pnpm test:network`, each once;
		- every requirement the witness verdict now exposes gets an arm or steering, never more runs;
		- each design's planted-bug check (§11.5) moves to the mutation gate (item 5), since the owner allows only combined runs here;
		- rerun each issue's acceptance check.
		- close GitHub issues #1–#8, each with a one-line comment naming the commit that fixes its root cause.
		- owner 2026-11-04: push and send Sterling his file at the first clean `pnpm check` ("one typecheck. run tests later"); `pnpm test` and `pnpm test:network` run together after the push, looping fix and re-run until green, and Sterling gets a follow-up when they are.
		- then send Sterling a single self-contained migration markdown, built from CHANGELOG.md and pinned to the pushed commit, that his agent can execute end to end: dependency update, every codemod, typecheck to clean, regenerate migrations, re-create databases, verify. Send it as a Superbuilders Slack DM (D0C7QFQ3691) through the owner's logged-in Chrome tab.
	- **Types and engine agree everywhere, by the one Meets:** ChangeSet query members (types/changeset/changeset.ts MemberCheck) still compare decoded heads, `[Ha] extends [F]`, so a member delivering an exact integer into an integer field is refused by the types while the engine admits it (write/frontend/dag.ts writtenCast: proof, or PartialOperation). Rebuild MemberCheck over the member's carriers and the relation's field descriptors through Meets, as the recursive arms' ArmsDeliver now does; then sweep every other head-against-declared-field check for the same split.
	- **Cut, after the gate, in Elon's order.** Question every mechanism this item added: lint rules, test projects, arms, oracles, carriers, preconditions. Delete what another one subsumes, then simplify representation-first, then run the gate once more.
	- **Pacing:**
		- runs main launches use half the machine (5 of 10 cores);
		- PostgreSQL 19 RC2 (2026-11-12) is repinned between waves, never inside one;
		- each wave ends with one typecheck, then commit and push.
2. **edullm catch-up, outside school hours** (owner 2026-11-03: superstarter and grizzle first). An edullm push deploys, so open tabs get version skew in school hours. Copy into edullm: item 1's testing-library change (#1, and #6's two packages/testing spread fixes), byte-identical with the package name substituted; the `no-spread-argument` rule and its REJECTED entry; and the shared lint SPEC (edullm/out/lint-standard/SPEC.md). Coordinate with any open edullm session.
3. **Representation-first cull: follow-ups.** When these are done, scripts/dev/golden/* is deleted (with its .fallowrc.json entry and the capture.ts line in oxlint.config.ts's no-dynamic-imports block).
	- **Assert roots still scheduled:**
		- regex membership without the one named site: DAG headings and expression types carry resolved types IR-wide;
		- analysis.ts attachNode: an analysis field on the IR's Attach node, kept apart from the lowering's claim and projected out of the digest the way Delta keys are, so the lowerings read the analyzed facts instead of matching three DAGs by Attach id;
		- variant-typed page slots and a total size encoder (pageBinding), threaded through the page compile, the kits, Delivery<Own> and the shell;
		- install/comments.ts mintedName: SQL AST names carry identities;
		- `sameOptional` in ir/scalar-shape.ts compares by canonical text until ExprTable has structural equality;
		- scalar/values/identity.ts builds row-identity strings as Map keys;
	- **Upstream report for fallow:** unused-class-member doesn't follow union narrowing, so check/params.ts ParamCell.use/useRelation (called on a narrowed BindValue) needs a usedClassMembers entry. Report it, then drop the entry once fallow is fixed.
	- **For a later pass:**
		- gen/query.ts's `#canFail` and `#stable` side tables fold into typed generator terms that carry their own failure and volatility;
		- the oracle's value-identity string keys (valueKey, rowKey, …) become structural identity, if a native structural map ever beats them.
4. **Test improvement on the library:**
	- **Baseline:** the mutation score per area, the residual per suite and the wall time.
	- **Oracles:** every rewrite, demand, prune and law rule notes a reach-then-reveal pair, `c.pair(rule, "reveal")`, defined on the node's own input; agree equivalences; kept cases from real reports; and test/pg/page/generated.ts's conservative population capped by a request count computed from the sketch, with no milliseconds-per-request derivation.
	- **Worlds and schedules:** commands programs for ledgers, sessions and pools; drawn schedules for races too large for `every`; shared.ts's lease-slot wait (it blocks while other slots are free, and the build guard doesn't count it); and every pg or schedules suite that sits on an unadjusted TestClock moved to the live clock.
	- **Education leads:** test/support/worlds/generate/enumerate.ts's candidate box varies one claim field at a time from the first values, so a school administrator's account and school rarely appear together and the administrator's accepted write stays rare (1.5% per case). Make the box draw claim fields jointly. The leads' `whilePending` gate recognises only worlds features, so education requirements always look pending. Give it the suite's own requirement set.
	- test/support/pg.ts takes SQL parameters as ReadonlyArray<unknown>, which let an Identity object reach a query; type the parameters.
	- test/pg/physical/serving.test.ts's first workload kept case (about 780 lines) shrinks to its minimal sketch, and the floor helpers it and the second one use (zeros, floorValue, floorCompare, match, read) move into one shared module with test/pg/oracle/public/suite.ts's kept-sketch helpers. The library's shrinker can't start from a kept value; give it a way to (a kept case's draws as its tape).
	- While logical/props.ts held a type error (Closure<undefined> against Closure<never>), the type batch's tsc hung at 0% CPU with every thread waiting instead of reporting it. Reproduce and report it upstream (typescript-go), and make the batch fail closed on a stall (test/types/batch).
	- **Library limit:** the case hang guard races a timer on the case's own thread, so a synchronous runaway (a backtracking RegExp, a pure loop) blocks it and vitest's timeout alike; only a worker thread can stop one (worker.terminate interrupts a running RegExp). Decide whether property cases run in a terminable worker, or document that synchronous code under test must be budgeted, as the engine's BudgetMeter does.
	- The oracle perturbation never draws `enable_nestloop = off`. PostgreSQL 19 gates the nested loop's materialize and memoize on it, so a join no other enabled method runs re-reads its inner side per outer row. As a result, perturbations can't force a hash or merge join where the planner picks a nested loop. Restore that from the sketch: draw `enable_nestloop = off` only for a sketch whose every join some enabled method can run (no cross product, no vector equality, never with hash and merge joins both off).
	- The 40001 retry covers only expectation steps (test/support/substrate/expect.ts). A plain setup statement in a pg suite can still meet SSI's load-induced 40001. Find every suite that sets up through raw autocommit statements, and route their setup through one attempt-and-observe helper.
	- **Engine units:** exhaust small boxes, and agree.
	- **Then adequacy:** every surviving mutant and fuzz find becomes a generator arm or a required situation.
	- **Done means:** the mutation score is up in every area, no residual is worse, and total wall time is no worse at four cores.
5. **The mutation gate:** prune triage.json, then run the operators on the final code. Every surviving mutant becomes a test or a written equivalence.
6. **Tests move into packages/*/test**, with their mutate and fallow paths and the docs.
7. **Narrow the engine's internal exports** to compiled outputs: read plan, change plan, migration plan, expected catalog.
8. **Keys follow-ups:**
	- lowering rewrites' key claims rest on certificates, not KeyProofs;
	- a projection drops a dependency whose determinants include a column it drops;
	- a lateral source column fixed to a region column gives only one direction;
	- k joined relations with two declared keys each still give 2^k minimal keys;
	- a closed relation's identical-valued columns aren't detected as one class.
9. **Terms, typed:** a `CheckedExpr` brand with per-level constructors (about 40 builder sites), so each builder's level check is mechanical.
10. **Sweeps under conflicting key orders, the residues no plan avoids.** The created-index key order serves every request of the relation one order can (packages/engine/src/physical/indexes/engine.ts), and the serving judge holds the engine to that. What remains is requests needing conflicting key orders, where PostgreSQL sweeps another planned index for the one request no order serves. The judge excuses exactly those sweeps, through an index no order of whose keys serves the probe beside the requests it serves (test/pg/physical/serving.ts residueOf); the request's own index alone must still serve the probe.
	- **GiST:** gistcostestimate is blind to column position. It costs a GiST scan by the selectivity of all its conditions (genericcostestimate), and charges its descent ceil(ln N) comparisons where btcostestimate charges ceil(log2 N). So at the one leaf a selective result needs, PostgreSQL prefers a GiST index that holds a probe's fields outside its lead to a B-tree those fields lead (6.50 against 6.51 at the serving suite's volume), or to a GiST index of as many pages, and sweeps it. A span predicate on (fixed, span), another on (span) and an equality lookup on (fixed): whichever column leads, one single-column probe is exposed. Closing it needs gistcostestimate to see column position, an upstream change.
	- **Partial B-tree:** a law probe of a selection whose own index holds every row (law probes of the held bookings on (room, id) and (id), beside one on (room) the span key's GiST index serves). btcostestimate's skip-scan costing gives up skipping when the skipped columns' distinct values outnumber the index's pages and costs a sweep; an index-only sweep of the partial (id, room) WHERE held fetches no heap page, so PostgreSQL sweeps it (74 buffers) rather than read the GiST index of every row (117). PostgreSQL is right here; avoiding it would take leading the partial index with room for the probe an index already serves, and a second partial index for (id), which the engine's draft, ordered for the requests no index serves, never makes.

## Tests owed (behaviour README states that no test holds)
- **Claims:**
	- a context field of every admitted type, contract and closed handle included, in one drawn context, with a pattern needing PostgreSQL's regex semantics;
	- a direct writer's hand-set claim its field refuses, of every admitted type, meets README's codes at the read: 22P02 (no JSON, a non-uuid, non-integer, non-boolean, unknown closed handle), 22003 (an integer out of range), 23514 (a contract or pattern);
	- a refined claim whose domain the installed snapshot lacks is OpenError at admission;
	- admission stays one round trip with N refined claims.
- **Roles:** the exhaustive small space, meaning every entry over a two-relation base with at most two arms and one context, with classification and admission agreeing.
- **Logins:**
	- two logins of one schema and two schemas in one process, each login its own pool, Db.open never crossing layers, pools released on scope close;
	- a Db per request at volume on one pool, alternating roles.
- **Reading a world:**
	- page through a world view with a proven key and with a derived key, every row exactly once;
	- attach deliveries in roles;
	- recursion and spans read through world views.
- **Writing through a world:**
	- entries over a mutable relation with a span key, and over a pure set;
	- every law family meeting an entry write;
	- 100,000 facts through one entry, index-served.
- **Read-backs:** a drawn version over generated ChangeSets and entries, each read-back classified against a host restatement of the rule.
- **Refusals:** every law family's refusal raised by a partial role, with the withheld or shown rule judged by the law function's role check.
- **Installation:** a second generate drafts no change to login defaults.
- **Drift:** a drawn change to each world object kind is reported by `grizzle drift` with the object named, and nothing on a fresh install.
- **Packaging:** the package test's consumer opens a role against the dev cluster (built package, real Db.open, one read).
- **Performance under roles:**
	- every workload program over a role reads through its indexes;
	- the prologue adds no round trip.
- **README clauses:**
	- A JavaScript program over a context its role's relations don't read is refused before any SQL.
	- No law takes a context, and no ChangeSet writes it.
	- USAGE on every domain down a contract's base chain.
	- A non-19 server is refused at stage `version`, and a verdict-less admission at stage `admission`.
	- SET ROLE or SET SESSION AUTHORIZATION to a missing role gives 22023.
	- A plain foreign key on a cycle is refused at COMMIT.
	- A failing password Effect fails a read with ReadFailure at stage acquire, and a write with TransportFailure.
	- A throwing verify gives TokenError at stage token, and a refined claim PostgreSQL refuses gives ClaimRefused at stage token.
- **Planted defects:** each new suite is shown failing on a planted defect in its feature.

## Before the beta
- Performance under roles: the 1M-row plan suites read through world views and row security, every read index-served, measured against the full role.
- Keep, or verify on real RDS, the README's `rds_iam` grant (`WITH INHERIT TRUE, SET FALSE`).
- Re-read the README's PostgreSQL 19rc1 and recursive-UNION patch statement.
- `bench:full` and `mutate` once, before tagging.

## Effect 4.1
- scripts/dev/profile/compile.ts digests through `effect/crypto`: `yield* Digest.Digest`, then `digestHex(Digest.sha256, bytes)` in place of `Crypto.Crypto`'s digest and `Hex.encode`, with `Digest.layerWebCrypto` provided to `main`. 4.1 drops `Crypto` from `effect` and NodeServices no longer carries one; this is the only site 4.1's typecheck refuses.
- The catalog's effect, @effect/platform-node and @effect/vitest move to 4.1 together (@effect/vitest 4.1 requires effect ^4.1.0), with `pnpm test` and `pnpm test:network` green on it.
- packages/grizzle's and packages/engine's `effect` peer rises to ^4.1.0 in the same commit: the gate then typechecks against 4.1 alone, so a 4.1-only API would otherwise slip in under a 4.0 floor.

## PostgreSQL calendar
- PG19 RC2 (2026-11-12) and GA (2026-11-19): repin (pin.env, rebuild, re-init, delete the old build). Drop each pin patch once a release includes its fix.
- **Fixed for RC2 that touch us:**
	- DROP DATABASE … WITH (FORCE) failing on parallel autovacuum workers (1ff3180ca01, fix a39e53a70). test/support/substrate/shared.ts's sweep runs exactly that, so a sweep can fail intermittently on rc1.
	- The RI fast path diverging when an FK value needs a cast (2da86c1ef9b). grizzle pairs FK columns of identical types, so it shouldn't trigger. Confirm after the repin.
	- Executor hash tables sized from an unclamped planner estimate since 8f29467c (BUG #19759, fix 747dbf30d1): a recursive UNION zeroed up to 64 GB at executor start, plain EXPLAIN included. scripts/pg/patches/19rc1-recursive-union-hash-mem.patch is that fix, backported unchanged, so the repin drops it.
- scripts/pg/patches/19rc1-btree-gist-multibyte-penalty.patch is master's b82d69abf6, which no 19 release includes: the RC2 and GA repins keep it (REL_19_STABLE's btree_gist is unchanged since RC1, so it applies as is), and the PostgreSQL 20 repin drops it.
