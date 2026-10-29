# grizzle TODO

The one plan: only work still to do. A finished item is deleted, not ticked.

## Now, in order
1. **Representation-first cull: follow-ups.** When these are done, scripts/dev/golden/* is deleted (with its .fallowrc.json entry and the capture.ts line in oxlint.config.ts's no-dynamic-imports block).
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
2. **Test improvement on the library:**
	- **Baseline:** the mutation score per area, the residual per suite and the wall time.
	- **Oracles:** every rewrite, demand, prune and law rule notes a reach-then-reveal pair, `c.pair(rule, "reveal")`, defined on the node's own input; agree equivalences; kept cases from real reports; and test/pg/page/generated.ts's conservative population capped by a request count computed from the sketch, with no milliseconds-per-request derivation.
	- **Worlds and schedules:** commands programs for ledgers, sessions and pools; drawn schedules for races too large for `every`; shared.ts's lease-slot wait (it blocks while other slots are free, and the build guard doesn't count it); and every pg or schedules suite that sits on an unadjusted TestClock moved to the live clock.
	- **Education leads:** test/support/worlds/generate/enumerate.ts's candidate box varies one claim field at a time from the first values, so a school administrator's account and school rarely appear together and the administrator's accepted write stays rare (1.5% per case). Make the box draw claim fields jointly. The leads' `whilePending` gate recognises only worlds features, so education requirements always look pending. Give it the suite's own requirement set.
	- test/support/pg.ts takes SQL parameters as ReadonlyArray<unknown>, which let an Identity object reach a query; type the parameters.
	- test/pg/migrate/renames.test.ts has a FeaturesUnreached: find the rare situation and give it an arm.
	- test/pg/physical/serving.test.ts's first workload kept case (about 780 lines) shrinks to its minimal sketch, and the floor helpers it and the second one use (zeros, floorValue, floorCompare, match, read) move into one shared module with test/pg/oracle/public/suite.ts's kept-sketch helpers. The library's shrinker can't start from a kept value; give it a way to (a kept case's draws as its tape).
	- While logical/props.ts held a type error (Closure<undefined> against Closure<never>), the type batch's tsc hung at 0% CPU with every thread waiting instead of reporting it. Reproduce and report it upstream (typescript-go), and make the batch fail closed on a stall (test/types/batch).
	- **Library limit:** the case hang guard races a timer on the case's own thread, so a synchronous runaway (a backtracking RegExp, a pure loop) blocks it and vitest's timeout alike; only a worker thread can stop one (worker.terminate interrupts a running RegExp). Decide whether property cases run in a terminable worker, or document that synchronous code under test must be budgeted, as the engine's BudgetMeter does.
	- The oracle perturbation never draws `enable_nestloop = off`. PostgreSQL 19 gates the nested loop's materialize and memoize on it, so a join no other enabled method runs re-reads its inner side per outer row. As a result, perturbations can't force a hash or merge join where the planner picks a nested loop. Restore that from the sketch: draw `enable_nestloop = off` only for a sketch whose every join some enabled method can run (no cross product, no vector equality, never with hash and merge joins both off).
	- The 40001 retry covers only expectation steps (test/support/substrate/expect.ts). A plain setup statement in a pg suite can still meet SSI's load-induced 40001. Find every suite that sets up through raw autocommit statements, and route their setup through one attempt-and-observe helper.
	- **Deploy, migrate and the CLI:** exhaust over the finite rename and migration spaces, and commands for migration sequences.
	- **Engine units:** exhaust small boxes, and agree.
	- **Then adequacy:** every surviving mutant and fuzz find becomes a generator arm or a required situation.
	- **Done means:** the mutation score is up in every area, no residual is worse, and total wall time is no worse at four cores.
3. **The mutation gate:** prune triage.json, then run the operators on the final code. Every surviving mutant becomes a test or a written equivalence.
4. **Tests move into packages/*/test**, with their mutate and fallow paths and the docs.
5. **Narrow the engine's internal exports** to compiled outputs: read plan, change plan, migration plan, expected catalog.
6. **Keys follow-ups:**
	- lowering rewrites' key claims rest on certificates, not KeyProofs;
	- a projection drops a dependency whose determinants include a column it drops;
	- a lateral source column fixed to a region column gives only one direction;
	- k joined relations with two declared keys each still give 2^k minimal keys;
	- a closed relation's identical-valued columns aren't detected as one class.
7. **Terms, typed:** a `CheckedExpr` brand with per-level constructors (about 40 builder sites), so each builder's level check is mechanical.
8. **Sweeps under conflicting key orders, the residues no plan avoids.** The created-index key order serves every request of the relation one order can (packages/engine/src/physical/indexes/engine.ts), and the serving judge holds the engine to that. What remains is requests needing conflicting key orders, where PostgreSQL sweeps another planned index for the one request no order serves. The judge excuses exactly those sweeps, through an index no order of whose keys serves the probe beside the requests it serves (test/pg/physical/serving.ts residueOf); the request's own index alone must still serve the probe.
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
- **Migrations:**
	- login rename chains and swaps, a login renamed while its roles change, and the login-role name exchange refused by name;
	- generated world histories whose every version equals a fresh install.
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
