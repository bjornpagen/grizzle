/**
 * The isolation certifier (analysis/isolation/certify.ts) over drawn installations: two logins' roles over four
 * relations, each relation with rules over queries stated at it or not, each by its witnesses (analysis/theory/query.ts
 * Witness: one or two rows of matches, absences, rarely presences beyond them, over any relations), declared keys, its
 * first raced or not, counted groups and
 * foreign keys (immediate or deferred alike, an update cascading or not), each role's privileges, and its change members'
 * statements, each reading relations, positively, negated, counted or as grizzle's key arbitration, its own rows or not,
 * by a group whose fields are bound to one value or to one per own row, k0 and k1 to one parameter or each to its own,
 * or none, and writing relations, by insert, update or delete, with each
 * written row joined with some of its statement's reads; its members as served at READ COMMITTED, and those of its SERIALIZABLE
 * form, which certification lowers it to once a round leaves it SERIALIZABLE. Some draws are counterexamples: two copiers, each inserting
 * into one relation and then copying the other's (by a scan, or at a whole key); a writer reading another's absence
 * beside a reader of both; a chain of SERIALIZABLE readers; a SERIALIZABLE pivot writing what an RC member reads
 * unsealed; a write after an outside read joined with no row of its call; an insert into a relation an update cascades
 * to; an inserter beside a SERIALIZABLE role that may insert too, whose guard would refuse its every write; and
 * NEGATION's four histories no serial order in real time explains, each reproduced on PostgreSQL: a reader of one point
 * group lagging an in-flight SERIALIZABLE pivot, a reader of one group per own row, a copy whose foreign key check
 * misses that pivot's row (refusedCopy), and a copy over many own rows whose deferred check reads at COMMIT; and a
 * referencer whose check reads a relation a role updates (updatedCheck, updatedDeleter). The copy whose check misses the
 * pivot's row runs READ COMMITTED once the pivot's login fences the relation, as every login does whose role runs
 * SERIALIZABLE, may miss another call's write and writes a relation a READ COMMITTED role checks (refusedCopy,
 * publication, unfencedPivot, newlyFenced); a plain read of such a relation stays SERIALIZABLE, fence or not
 * (newlyFencedRead). Others are READ COMMITTED, the deleting login fencing the relation:
 * a referencer of a relation deleted from another login than the one that inserts it, by a privilege (heldCheck) or a
 * member (fencedDeleter), or deleted and inserted by one login (fencedCheck), edullm's publisher among them, which
 * replaces it in one member after an outside read (fencedPublisher). LEASE's race shapes: a
 * read of a race's winner that binds the raced key as its arbitration did and another field besides, arbitrated and
 * READ COMMITTED; the same read at another value of the key or of a part of it, and a raced relation's read at another
 * key its insertion was probed at, each a pivot; and that read where the relation is not raced, whose probed key is fixed too.
 *
 * The oracle restates every condition over the drawn facts, apart from the certifier's code, in rounds from none
 * lowered: each judged role's own conditions over its READ COMMITTED members, a rule over a query it writes a relation
 * of failing condition 2 where its write breaks a witness (makes a row present where the witness reads it as a row or a
 * presence, absent where as an absence; an update both) that holds other than exactly one occurrence any write can make true, a row, and every
 * relation of every witness its writes break an outside read of it for 5c; its foreign key checks among its reads,
 * a referencing check sealed where it binds a whole declared key of a relation no role updates (an insert-only one's,
 * a held one's and a fenced one's alike, fenced where one login's roles both delete and insert it), a fenced write's
 * check of the rows that reference a row it deletes no site of conditions 2 and 3, and no sealed check an outside read 5c
 * weighs, every login whose writes of its relation could meet it out of order fencing it; then, of the judged roles
 * that meet them, the greatest set none of whose members a role outside it gives a reason,
 * found by trying every subset, where whatever a lowered role's members read or write, conditions 2, 3 and 5c included,
 * is read from both its forms; each round lowers the judged roles it leaves SERIALIZABLE, with its conditions, until one
 * lowers none. Every role's level is the oracle's, the fences are exactly those of the relations the roles it leaves
 * READ COMMITTED check by sealed checks, one per login that fences each (each whose roles delete it, and each of a role
 * it lowered that may miss another call's write and writes it), and every SERIALIZABLE role names exactly the
 * conditions of the round
 * that lowered it, each of which it still fails at the fixpoint: its own where it fails any of its own, else, under
 * each role that runs SERIALIZABLE at that round's end and gives it one, in the roles' order, exactly the conditions
 * that role alone gives it (certify.ts Serializable); a role with no change member is SERIALIZABLE by the
 * members condition. Every role's certificate is the same with its own SERIALIZABLE form dropped: that form is served
 * only once the role runs SERIALIZABLE, so it never judges the role. Adding a capability (a privilege, a read, a
 * statement, a member, a member of a SERIALIZABLE form, a role, an insert with no insert, a trigger-held law, a foreign
 * key, a race over a relation's first key) never makes a SERIALIZABLE role READ COMMITTED, nor does removing a relation's fact, but for the first change
 * member of a role with none, which the members condition alone held, and an arbitration added to a member's first
 * statement, no capability but grizzle's own key arbitration, which fixes the row a later read of its key reads. No level rests on a fence: 5c weighs no sealed
 * check, whichever logins fence its relation, so a capability that makes a login fence one, a deletion or a pivot cause,
 * relaxes no reader (the newlyFenced shape). Such a fence changes the login's writes, each of which then locks the
 * relation IN EXCLUSIVE MODE before its snapshot; the fence is installed (the login's MAINTAIN grant on the relation,
 * physical/ddl/roles.ts), so the installation's snapshot, and the fingerprint every served file names, change, and a
 * migration stands between the two: each transaction of a migration takes the ledger's ACCESS EXCLUSIVE lock first,
 * waiting for every Db transaction in flight (adapter/migrate/apply.ts), and every Db transaction takes the ledger's
 * ACCESS SHARE lock NOWAIT, refused while a migration holds or waits for it (55P03), then calls the snapshot guard with
 * its served file's fingerprint, refused where a folder is part-way (55Z02) or the latest complete target is another
 * snapshot (55Z01), before its first statement takes a snapshot (adapter/wire/batch.ts Prologue, physical/ddl/ledger.ts
 * snapshotGuardDdl). So no call of the unfenced writers runs beside a call that relies on the fence. Every
 * counterexample comes out SERIALIZABLE.
 *
 * Planted in a scratch copy, each of these fails the search: condition 2's SERIALIZABLE readers left out; the fixpoint
 * run once; a pivot's write before a group read only later let through; a pivot's write after an outside read joined
 * with no row of its call let through; an unsealed read sharing a member with an outside read in another statement let
 * through; condition 5c left out; a read binding part of a declared key sealed as a point; a role with no change member
 * certified; a role with no change member read as writing and reading nothing, or reading rows present alone, or its
 * checks of what it writes sealed as a served writer's, though its direct transactions take no fence; an
 * arbitration of no whole key sealed; an arbitration of a relation a role deletes sealed; a relation
 * another role deletes written READ COMMITTED; 5c's exemption of sealed reads restored; a read of one group per own row
 * sealed; foreign key checks left out of 5c; the checks of rows that reference a changed one left out; a cascading
 * update left out of the writers; a relation with no fact read as having no foreign key (the droppedReference shape); a
 * relation a SERIALIZABLE role writes too written READ COMMITTED; an unsealed read beneath a neutral probe; a probe
 * neutral with no positive read of its group, with a gated write no read of it joins (the unjoinedGate shape), or with
 * no row path from its core (the fallbacks), one through a read beneath other probes (the chainedPath shape), of
 * another group or no positive one (the arbiterPath shape), through one UNION arm alone (the unions at another key,
 * another relation or the recursion's own rows), through no UNION or no core at all; and the arbitrated read without
 * its clean prefix; a SERIALIZABLE writer's sealed foreign key checks counted as a pivot cause; a SERIALIZABLE form left
 * out of a role's judging (the served cause), of the relations' writers (the served update) or of the absence sites (the served
 * absence); a lowered role judged again over both its forms, its own lowering's absence named in place of the reasons
 * that lowered it (the lowered absence, edullm's folded publisher); and a lowered role's certificate read from the last
 * round, over its READ COMMITTED form alone, where another role's lowering gives it an absence of its own (the lowered
 * cause); a check of a relation a role updates sealed (the updatedCheck shape); a fenced check relied on with no fence
 * stated (the fencedCheck shape); every check of referencing rows a fenced site (updatedDeleter); and a sealed check of
 * a relation a pivot writes relied on with no fence of the pivot's login (the refusedCopy shape), which NEGATION's case
 * 3 refutes: a point check never fenced, or no pivot's login fencing.
 *
 * A second search draws statements whose query CTEs are instances (analysis/isolation/facts.ts CteFacts), each read at
 * up to three uses, beneath a probe of its site or none, its probes in its own cores or in its site's (SiteCore `site`),
 * one instance reading another, swarmed per case between the broad vocabulary above and a dense one of two insert-only
 * relations read at k0's one parameter, where a probe's judgement turns on its row path. It holds the certifier to the
 * expansion of each statement (test/support/expanded.ts), each instance read again at each use, as a second
 * implementation: every read takes the modes its reads take there (readModes), every role the same level with the same
 * reasons, each once, but a write's count of its other unjoined outside reads, and the same fences. That count is held
 * apart, with the case's SERIALIZABLE forms dropped so every round reads one installation, to its contract restated over
 * the expansion (unjoinedOracle): the other outside reads of the statement the write is joined with none of, each read
 * of the statement once, a query CTE's read once whatever sites and arrivals read it (CteFacts.query).
 *
 * A third search, the form search, draws the main search's installations with some roles holding a change member that
 * has no READ COMMITTED form (analysis/isolation/facts.ts Unformed), an insert into a span primary key, at one or two
 * sites each; such a role holds no member at READ COMMITTED. Its oracle is the main search's rounds from those roles
 * lowered already, by `form` alone: every role runs at the oracle's level, a role with no READ COMMITTED form names
 * exactly its sites (each member and relation, condition `form`, no statement) and nothing else, and every other role
 * that runs SERIALIZABLE names exactly the conditions of the round that lowered it, those roles' SERIALIZABLE forms
 * among the facts it was judged by. Features: a role SERIALIZABLE by form, and beside one a role certified READ
 * COMMITTED, a role SERIALIZABLE by reasons one gives, and a judged role SERIALIZABLE by its own conditions.
 *
 * DENSEATS's repro and its four neighbours (monotoneOf): a role that inserts R and E under a rule whose witness reads
 * one row of R and E's absence runs READ COMMITTED (the monotone writer); a deleter of E, a self-join of R, E read
 * present, or a SERIALIZABLE inserter of E that may miss a write each leave it SERIALIZABLE.
 *
 * Features: each condition failed and met, each counterexample shape, each level, each capability added or fact
 * removed, a role lowered in a later round, a role whose lowered form alone reads the absence of what it writes, a held
 * check beside a READ COMMITTED role, a check of a relation one login deletes and inserts, a fence a READ COMMITTED
 * role relies on, a READ COMMITTED role whose write fires a monotone rule's probe, and one whose writes of a rule's
 * relations only withdraw its violations (the required situations of the search).
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { certify, isolationOf, readSeal } from "#compiler/analysis/isolation/certify.ts"
import {
	type IsolationCondition,
	type IsolationReason,
	reasonsOf
} from "#compiler/core/certificate.ts"
import { expanded } from "#test/support/expanded.ts"
import {
	absenceOfItsOwnLowering,
	addsArbitration,
	afterOf,
	caseGen,
	certifiedRoles,
	conditions,
	counterexampleRoles,
	deletedIn,
	everyCondition,
	expectedFences,
	fencesOf,
	fencesUndeleted,
	flatFacts,
	formCandidates,
	formCaseGen,
	type FormFeature,
	formOf,
	givesFirstMember,
	inputOf,
	type IsolationFeature,
	lawsOver,
	levelsOf,
	mentions,
	modeFeatures,
	modeKey,
	modesTaken,
	type ModeTaken,
	oracle,
	oracleFrom,
	oracleRound,
	readFact,
	reasonKey,
	type ReasonSite,
	reasonSite,
	relationsOf,
	rowPathFeatures,
	sealFeature,
	shapeAims,
	shapeCaseGen,
	shapes,
	type SharedCase,
	sharedCaseGen,
	twoReachCaseGen,
	sharedCertified,
	type SharedFeature,
	sharedFeatures,
	sharedInput,
	unjoinedOracle,
	unjoinedReason,
	unmaskedKey,
	verdictsOf,
	withRelation,
	withRole
} from "#test/unit/analysis/isolation/certify.fixtures.ts"

/** A role that gives another a reason to run SERIALIZABLE, by name, and the conditions it gives. */
interface GiverConditions {
	readonly role: string
	readonly conditions: ReadonlyArray<IsolationCondition>
}

/** The conditions among `named`, each once, in the order everyCondition lists them. */
const conditionsIn = (
	named: ReadonlyArray<IsolationCondition>
): ReadonlyArray<IsolationCondition> => Arr.filter(everyCondition, (x) => named.includes(x))

/**
 * The isolation certifier runs a role READ COMMITTED exactly when every condition proves it, names every condition a
 * SERIALIZABLE role fails, and never relaxes a role for an added capability or a missing fact.
 *
 * Budget: 500 runs and 500 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/isolation/certify.test.ts:4242 at 8cad5bce, its runs and its coverage's cases).
 */
export const theIsolationCertifierRunsARoleREADCOMMITTEDExactlyWhenEveryConditionProvesItNamesEveryConditionASERIALIZABLERoleFailsAndNeverRelaxesARoleForAnAddedCapabilityOrAMissingFact =
	property.explore(
		aimed(
			caseGen,
			Arr.map(shapeAims, ([situation, shape]) => [situation, shapeCaseGen(shape)] as const)
		),
		{
			needs: {},
			budget: { runs: 500, steered: 500 },
			situations: [
				"a role certified READ COMMITTED",
				...Arr.map(conditions, (c) => `a role SERIALIZABLE by ${c}` as const),
				"a role SERIALIZABLE only through roles that run SERIALIZABLE",
				"a role SERIALIZABLE through two roles that run SERIALIZABLE",
				"a counted group read",
				"a point read",
				"a read of a relation no role writes",
				"an arbitration a unique check decides",
				"an arbitration of no whole declared key",
				"a first change member given to a role with none",
				"a read of one group per own row",
				"a foreign key check beside a READ COMMITTED role",
				"a held foreign key check beside a READ COMMITTED role",
				"a check of a relation one login deletes and inserts",
				"a fence a READ COMMITTED role relies on",
				"a fence of a relation no role deletes",
				"a check of the rows that reference a changed one",
				"an update carried by a cascading foreign key",
				...Arr.map(shapes, (s) => `the ${s}` as const),
				"a fact dropped beside a READ COMMITTED role",
				"a dropped fact a SERIALIZABLE role's level rests on alone",
				"a role whose lowered form alone reads the absence of what it writes",
				"a role lowered in a later round",
				"a READ COMMITTED role whose write fires a monotone rule's probe",
				"a READ COMMITTED role whose writes of a rule's relations only withdraw its violations"
			] satisfies ReadonlyArray<Reached<IsolationFeature>>,
			check: (_, k: CaseOf<IsolationFeature>) => (c) =>
				Effect.sync(() => {
					const input = inputOf(c.sketch)
					const verdicts = verdictsOf(c.sketch, input.relations)
					const expected = oracle(c.sketch)
					const fences = fencesOf(c.sketch, input.relations)
					assert.deepEqual(
						fences,
						expectedFences(c.sketch, expected),
						"the fences the READ COMMITTED roles' fenced checks rely on"
					)
					if (fences.length > 0) {
						k.note("a fence a READ COMMITTED role relies on")
					}
					if (fencesUndeleted(c.sketch, fences)) {
						k.note("a fence of a relation no role deletes")
					}
					for (const [i, v] of verdicts.entries()) {
						const o = Arr.getUnsafe(expected.verdicts, i)
						assert.equal(
							v.certificate.level,
							o.readCommitted ? "readCommitted" : "serializable",
							`${v.role}'s level`
						)
						assert.deepEqual(
							Arr.getUnsafe(
								verdictsOf(
									withRole(c.sketch, i, (r) => ({ ...r, serializable: [] })),
									input.relations
								),
								i
							),
							v,
							`${v.role}'s certificate is the same without its own SERIALIZABLE form`
						)
						if (v.certificate.level === "serializable") {
							const why = v.certificate.why
							const named = new Set(Arr.map(reasonsOf(why), (r) => r.condition))
							assert.deepEqual(
								Arr.filter(everyCondition, (x) => named.has(x)),
								Arr.filter(everyCondition, (x) => o.failed.has(x)),
								`${v.role} names exactly the conditions of the round that lowered it`
							)
							const givers: ReadonlyArray<GiverConditions> =
								why.kind === "own"
									? []
									: Arr.map(why.by, (g) => ({
											role: g.role,
											conditions: conditionsIn(Arr.map(g.reasons, (r) => r.condition))
										}))
							assert.deepEqual(
								givers,
								Arr.map(Arr.sort([...o.givers.keys()], Order.Number), (j) => ({
									role: `r${j}`,
									conditions: conditionsIn([...defined(o.givers.get(j), `r${j}'s conditions`)])
								})),
								`${v.role} names its own reasons where it fails any of its own, else each role that runs SERIALIZABLE and gives it one, in the roles' order, with the conditions it gives`
							)
							assert.equal(
								why.kind,
								o.own.size > 0 ? "own" : "given",
								`${v.role}'s reasons are its own where it fails a condition of its own`
							)
							const judges = new Set(Arr.filter([...expected.lowered], (j) => j !== i))
							const at = oracleRound(c.sketch, judges)
							const still = new Set([...at.own(i), ...at.given(judges, i)])
							for (const r of named) {
								assert.ok(
									still.has(r),
									`${v.role} still fails ${r}, which lowered it, at the fixpoint`
								)
								k.note(`a role SERIALIZABLE by ${r}`)
							}
							if (o.own.size === 0) {
								k.note("a role SERIALIZABLE only through roles that run SERIALIZABLE")
							}
							if (o.givers.size > 1) {
								k.note("a role SERIALIZABLE through two roles that run SERIALIZABLE")
							}
							if (defined(expected.rounds.get(i), `the round that lowered ${v.role}`) > 0) {
								k.note("a role lowered in a later round")
							}
							if (absenceOfItsOwnLowering(c.sketch, expected.lowered, i)) {
								k.note("a role whose lowered form alone reads the absence of what it writes")
							}
						} else {
							k.note("a role certified READ COMMITTED")
							const round = oracleRound(c.sketch, expected.lowered)
							if (round.brokenBy(i).length > 0) {
								k.note("a READ COMMITTED role whose write fires a monotone rule's probe")
							} else if (
								Arr.some([...round.written(i)], (x) =>
									Arr.some(lawsOver(c.sketch.relations, x), ({ law }) => mentions(law, x))
								)
							) {
								k.note(
									"a READ COMMITTED role whose writes of a rule's relations only withdraw its violations"
								)
							}
							const role = Arr.getUnsafe(c.sketch.roles, i)
							for (const statements of role.members) {
								for (const st of statements) {
									for (const read of st.reads) {
										const feature = sealFeature(readSeal(input, readFact(read)))
										if (feature !== undefined) {
											k.note(feature)
										}
									}
									if (
										Arr.some(
											st.writes,
											(w) =>
												(w.op === "insert" || w.op === "update") &&
												Arr.getUnsafe(c.sketch.relations, w.relation).references.length > 0
										)
									) {
										k.note("a foreign key check beside a READ COMMITTED role")
									}
									if (
										Arr.some(
											st.writes,
											(w) =>
												(w.op === "insert" || w.op === "update") &&
												Arr.some(Arr.getUnsafe(c.sketch.relations, w.relation).references, (ref) =>
													deletedIn(c.sketch, ref.relation)
												)
										)
									) {
										k.note("a held foreign key check beside a READ COMMITTED role")
									}
								}
							}
						}
					}
					if (c.shape !== "drawn") {
						k.note(`the ${c.shape}`)
					}
					for (const i of counterexampleRoles(c.shape)) {
						assert.equal(
							Arr.getUnsafe(levelsOf(verdicts), i),
							"serializable",
							`the ${c.shape}'s role r${i} runs SERIALIZABLE`
						)
					}
					for (const i of certifiedRoles(c.shape)) {
						assert.equal(
							Arr.getUnsafe(levelsOf(verdicts), i),
							"readCommitted",
							`the ${c.shape}'s role r${i} runs READ COMMITTED`
						)
					}
					const settled = oracleRound(c.sketch, expected.lowered)
					for (const role of c.sketch.roles) {
						for (const statements of role.members) {
							for (const st of statements) {
								for (const read of st.reads) {
									if (
										read.mode === "arbiter" &&
										readSeal(input, readFact(read)).kind === "unsealed"
									) {
										k.note("an arbitration of no whole declared key")
									}
									if (read.group !== undefined && read.rows === "many" && !read.own) {
										k.note("a read of one group per own row")
									}
								}
								for (const w of st.writes) {
									if (
										(w.op === "insert" || w.op === "update") &&
										Arr.some(Arr.getUnsafe(c.sketch.relations, w.relation).references, (ref) =>
											settled.replaced(ref.relation)
										)
									) {
										k.note("a check of a relation one login deletes and inserts")
									}
									const referencing = Arr.filter(c.sketch.relations, (r) =>
										Arr.some(r.references, (ref) => ref.relation === w.relation)
									)
									if ((w.op === "update" || w.op === "delete") && referencing.length > 0) {
										k.note("a check of the rows that reference a changed one")
									}
									if (
										w.op === "update" &&
										Arr.some(referencing, (r) =>
											Arr.some(
												r.references,
												(ref) => ref.relation === w.relation && ref.onUpdate === "cascade"
											)
										)
									) {
										k.note("an update carried by a cascading foreign key")
									}
								}
							}
						}
					}
					const first = givesFirstMember(c.sketch, c.extension)
					if (first) {
						k.note("a first change member given to a role with none")
					}
					const arbitrated = addsArbitration(c.extension)
					const after = levelsOf(afterOf(c))
					for (const [i, level] of levelsOf(verdicts).entries()) {
						if (level === "serializable" && !first && !arbitrated) {
							assert.equal(
								Arr.getUnsafe(after, i),
								"serializable",
								`r${i} stays SERIALIZABLE once ${c.extension.kind} is applied`
							)
						}
					}
					const e = c.extension
					if (e.kind === "dropFact") {
						if (Arr.some(levelsOf(verdicts), (l) => l === "readCommitted")) {
							k.note("a fact dropped beside a READ COMMITTED role")
						}
						const lifted = oracle(
							withRelation(c.sketch, e.relation, (r) => ({ ...r, triggerLaws: [] }))
						).verdicts
						if (
							Arr.some(
								lifted,
								(o, i) => o.readCommitted && Arr.getUnsafe(levelsOf(verdicts), i) === "serializable"
							)
						) {
							k.note("a dropped fact a SERIALIZABLE role's level rests on alone")
						}
					}
				}),
			oracle: {
				kind: "specification",
				name: "every condition restated over the drawn facts, in rounds each the greatest of every subset"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: '\trole.writes.kind === "unknown"',
					replacement: '\trole.writes.kind === "unknown" && role.privileges.size < 0',
					why: "A role with no change member certified (certify.ts memberReasons); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\t\treturn isNonEmpty(writes)",
					replacement: "\t\t\treturn isNonEmpty(writes) && writes.length < 0",
					why: "A role with no change member read as writing nothing and reading nothing, no pivot cause, so an inserter of what its grants let it read is certified READ COMMITTED beside its direct writes (the directReached shape); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\t\t\t\t\t\t\t\treads: role.writes.readable.map(anyRead),",
					replacement: "\t\t\t\t\t\t\t\t\treads: [],",
					why: "Unknown writes bounded as reading nothing, so conditions 2 and 3 never weigh what a direct writer's grants let it read (the directReached shape); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						'\tif (at.writers.direct(relation)) {\n\t\treturn {\n\t\t\tkind: "unsealed",\n\t\t\tdetail: "a role writes it by direct SQL alone, whose transactions take no fence"\n\t\t}\n\t}\n',
					replacement: "",
					why: "A check of a relation a role writes by direct SQL alone sealed as a served writer's, relying on a fence its direct transactions never take, so the referencer of what it deletes is certified READ COMMITTED (the heldCheck and unfencedPivot shapes), which NEGATION's case 3 refutes; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: '\tmode: "negated",\n\tbase: "negated",',
					replacement: '\tmode: "positive",\n\tbase: "positive",',
					why: "Unknown writes bounded as reading rows present alone, so condition 3 never weighs a direct writer's read of an absence; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\twhile (changed) {",
					replacement: "\tif (changed) {",
					why: "The fixpoint over the roles a SERIALIZABLE role gives a reason run once (certify.ts round); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						'\t\t\treturn { kind: "lowered", candidate: r.candidate, lowering: r.lowering, why: r.why }',
					replacement:
						'\t\t\tconst again = ownReasons(at, r.view, absent)\n\t\t\tconst why: Serializable = isNonEmpty(again) ? { kind: "own", reasons: again } : r.why\n\t\t\treturn { kind: "lowered", candidate: r.candidate, lowering: r.lowering, why }',
					why: "A lowered role judged again over both its forms, its own lowering's absence named in place of the reasons that lowered it (the lowered absence); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						'\t\t\treturn { kind: "lowered", candidate: r.candidate, lowering: r.lowering, why: r.why }',
					replacement:
						'\t\t\tconst own = roleView(at, { role: r.candidate.role, members: r.candidate.role.members })\n\t\t\tconst again = ownReasons(at, own, absent)\n\t\t\tconst why: Serializable = isNonEmpty(again) ? { kind: "own", reasons: again } : r.why\n\t\t\treturn { kind: "lowered", candidate: r.candidate, lowering: r.lowering, why }',
					why: "A lowered role's certificate read from the last round, over its READ COMMITTED form alone, where another role's lowering gives it an absence of its own (the lowered cause); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						'\tif (at.writers.updated(relation)) {\n\t\treturn {\n\t\t\tkind: "unsealed",\n\t\t\tdetail: "a role updates the relation, which may move the key a check found"\n\t\t}\n\t}\n',
					replacement: "",
					why: "A check of a relation a role updates sealed (the updatedCheck shape); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						"\t\t\tview.members.flatMap((v) => v.checks.flatMap((c) => (lockedSeal(c.seal) ? [c.relation] : [])))",
					replacement:
						'\t\t\tview.members.flatMap((v) => v.checks.flatMap((c) => (c.seal.kind === "held" ? [c.relation] : [])))',
					why: "A fenced check relied on with no fence stated (the fencedCheck shape); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: '\tseal.kind === "point" || seal.kind === "held" || seal.kind === "fenced"',
					replacement: '\tseal.kind === "held" || seal.kind === "fenced"',
					why: "A point check relied on with no fence of the pivot that writes its relation (the refusedCopy shape), which NEGATION's case 3 refutes; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						"\t\t\t\t...pivots.flatMap((p) => (p.guarded.has(relation) ? [p.role.login] : []))",
					replacement: "\t\t\t\t...pivots.flatMap(() => [])",
					why: "No pivot's login fencing what it writes, so a sealed check of it is relied on unfenced (the refusedCopy and unfencedPivot shapes), which NEGATION's case 3 refutes; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: '\t\tjudgement.kind === "lowered" && view.cause !== undefined ? [view] : []',
					replacement: '\t\tjudgement.kind === "lowered" ? [view] : []',
					why: "A SERIALIZABLE writer that misses no write fencing what a READ COMMITTED role checks, a fence no certificate relies on; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: '\t\tjudgement.kind === "lowered" && view.cause !== undefined ? [view] : []',
					replacement: "\t\tview.cause !== undefined ? [view] : []",
					why: "A READ COMMITTED writer fencing what it writes, which 5c never weighs; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: '\tc.side === "referenced" && at.writers.fences(login, c.write)',
					replacement: '\tc.side === "referenced"',
					why: "Every check of referencing rows a fenced site (updatedDeleter); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\toutside: read,",
					replacement:
						"\t\toutside: new Set([...read, ...members.flatMap((v) => v.checks.flatMap((c) => (outside(c.seal) ? [c.relation] : [])))]),",
					why: "5c weighing every sealed check, as before a pivot's login fenced what it writes, so the copy it fences runs SERIALIZABLE (the refusedCopy, publication and unfencedPivot shapes); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						"\t\t\t\t\tf.relation === read.relation &&\n\t\t\t\t\tf.statement < statement &&\n\t\t\t\t\tf.bound.every((b) =>\n\t\t\t\t\t\tgroup.bound.some((r) => r.field === b.field && sameBinding(r.by, b.by))\n\t\t\t\t\t)",
					replacement: "\t\t\t\t\tf.relation === read.relation && f.statement < statement",
					why: "A read of an arbitrated relation at any bindings arbitrated (certify.ts fixedFor); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						'\t\tif (seals.some(({ seal }) => seal.kind !== "own" && seal.kind !== "arbiter")) {\n\t\t\tbreak\n\t\t}\n',
					replacement: "",
					why: "A key-matched read arbitrated after an outside read (certify.ts readsOf); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\t\t\t\tbound: group.bound.filter((b) => seal.key.includes(b.field)),",
					replacement: "\t\t\t\t\tbound: group.bound.filter((b) => b.field === seal.key[0]),",
					why: "A read matching the first field of an arbitrated key alone arbitrated (certify.ts readsOf); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						'\treturn facts.inserts.kind === "repeatable" || sameMembers(facts.inserts.key, key)',
					replacement:
						'\treturn facts.inserts.kind === "repeatable" || facts.inserts.key.length > 0',
					why: "A raced relation's arbitration at another key fixing its row (certify.ts fixesAt); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\t\t\t\tf.statement < statement &&",
					replacement:
						"\t\t\t\t\tf.statement < statement &&\n\t\t\t\t\tgroup.bound.length === f.bound.length &&",
					why: "A key-matched read with a binding besides the key left a point read, the old exact-group rule (certify.ts fixedFor); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: '\t\t\t\tif (p.mode === "negated" || p.mode === "counted") {',
					replacement:
						'\t\t\t\tif ((p.mode === "negated" || p.mode === "counted") && !installation.writers.fences(view.role.login, p.read.relation)) {',
					why: "A negated or counted read of a relation its reader's own login fences is no absence site (certify.ts absenceSites); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t...w.rows.flatMap((relation) =>",
					replacement: "\t...[...new Set(w.rows)].flatMap((relation) =>",
					why: "A witness's rows counted by relation, so a self-join's two rows count once and the self-join neighbour is certified READ COMMITTED; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						"\tconst read = new Set([\n\t\t...members.flatMap((v) => v.outsides.map((p) => p.read.relation)),\n\t\t...probed\n\t])",
					replacement:
						"\tconst read = new Set([...members.flatMap((v) => v.outsides.map((p) => p.read.relation))])",
					why: "The relations a role's probes read left out of its outside reads, so 5c misses the monotone rule's probe; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\t? [...readers, ...cowriters, ...keepers]\n\t\t: [\n\t\t\t\t...readers,",
					replacement: "\t\t? [...cowriters, ...keepers]\n\t\t: [",
					why: "Condition `laws` without its second half, a change member of a role that runs SERIALIZABLE reading a relation the role writes (givenReasons); the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						"\t\treturn isNonEmpty(reasons) ? [{ login: other.role.login, role: other.role.role, reasons }] : []",
					replacement:
						"\t\treturn isNonEmpty(reasons) ? [{ login: view.role.login, role: view.role.role, reasons }] : []",
					why: "A role's given reasons told as given by the role itself, not by the role that runs SERIALIZABLE and gives them (giversOf), so the line that tells which role to fix first names the wrong one; the search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						"\tjudges.flatMap((other) => {\n\t\tconst reasons = distinctReasons(givenReasons(view, other))",
					replacement:
						"\tjudges.slice(0, 1).flatMap((other) => {\n\t\tconst reasons = distinctReasons(givenReasons(view, other))",
					why: "A role given reasons by several roles that run SERIALIZABLE told only the first of them (giversOf); the search fails."
				}
			]
		}
	)

/**
 * The isolation certifier runs a role with a change member that has no READ COMMITTED form SERIALIZABLE from the first
 * round, naming each such member, and judges the others by its SERIALIZABLE form alone.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/isolation/certify.test.ts:4521 at 8cad5bce, its runs and its coverage's cases).
 */
export const theIsolationCertifierRunsARoleWithAChangeMemberThatHasNoREADCOMMITTEDFormSERIALIZABLEFromTheFirstRoundNamingEachSuchMemberAndJudgesTheOthersByItsSERIALIZABLEFormAlone =
	property.explore(formCaseGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a role SERIALIZABLE by form",
			"a role certified READ COMMITTED beside a role with no READ COMMITTED form",
			"a role SERIALIZABLE by reasons a role with no READ COMMITTED form gives",
			"a judged role SERIALIZABLE by its own conditions beside a role with no READ COMMITTED form"
		] satisfies ReadonlyArray<Reached<FormFeature>>,
		check: (_, k: CaseOf<FormFeature>) => (c) =>
			Effect.sync(() => {
				const sketch = formOf(c)
				const relations = relationsOf(sketch.relations)
				const certified = certify(relations, formCandidates(c))
				if (!certified.ok) {
					return assert.fail("a lowering of no error fails")
				}
				const verdicts = Arr.map(certified.value.roles, isolationOf)
				const unformed = new Set(Arr.map(c.unformed, (u) => u.role))
				const expected = oracleFrom(
					sketch,
					new Map(
						Arr.map(
							c.unformed,
							(u) =>
								[
									u.role,
									{
										readCommitted: false,
										failed: new Set<IsolationCondition>(["form"]),
										own: new Set<IsolationCondition>(["form"]),
										givers: new Map()
									}
								] as const
						)
					)
				)
				const settled = oracleRound(sketch, expected.lowered)
				for (const [i, v] of verdicts.entries()) {
					const o = Arr.getUnsafe(expected.verdicts, i)
					assert.equal(
						v.certificate.level,
						o.readCommitted ? "readCommitted" : "serializable",
						`${v.role}'s level`
					)
					const sites = Arr.findFirst(c.unformed, (u) => u.role === i)
					if (Option.isSome(sites)) {
						assert.deepEqual(
							v.certificate.level === "serializable"
								? Arr.map(reasonsOf(v.certificate.why), reasonSite)
								: [],
							Arr.map(sites.value.sites, (u): ReasonSite => ({
								condition: "form",
								at: { kind: "member", member: u.member, relation: u.relation }
							})),
							`${v.role} names each member with no READ COMMITTED form, and nothing else`
						)
						k.note("a role SERIALIZABLE by form")
						continue
					}
					if (unformed.size === 0) {
						continue
					}
					if (v.certificate.level === "readCommitted") {
						k.note("a role certified READ COMMITTED beside a role with no READ COMMITTED form")
						continue
					}
					const named = new Set(Arr.map(reasonsOf(v.certificate.why), (r) => r.condition))
					assert.deepEqual(
						Arr.filter(everyCondition, (x) => named.has(x)),
						Arr.filter(everyCondition, (x) => o.failed.has(x)),
						`${v.role} names exactly the conditions of the round that lowered it`
					)
					if (o.own.size > 0) {
						k.note(
							"a judged role SERIALIZABLE by its own conditions beside a role with no READ COMMITTED form"
						)
					} else if (Arr.some([...unformed], (j) => settled.given(new Set([j]), i).size > 0)) {
						k.note("a role SERIALIZABLE by reasons a role with no READ COMMITTED form gives")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the rounds of the main search's oracle from the roles with no READ COMMITTED form lowered already, by `form` alone, their READ COMMITTED members none"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/isolation/certify.ts",
				original: "\t\t\t\tlowering: candidate.lowering,",
				replacement: "\t\t\t\tlowering: { ...candidate.lowering, facts: [] },",
				why: "A role with no READ COMMITTED form lowered with no SERIALIZABLE facts (certify.ts standingOf), so a role its SERIALIZABLE form gives a reason is certified READ COMMITTED; the form search fails."
			}
		]
	})

/**
 * The isolation certifier reads a statement's query CTE instances as their expansion, each read again at each of its
 * sites: every role at the same level with the same reasons, each once, and the same fences.
 *
 * Budget: 500 runs and 500 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/isolation/certify.test.ts:4631 at 8cad5bce, its runs and its coverage's cases).
 */
export const theIsolationCertifierReadsAStatementsQueryCTEInstancesAsTheirExpansionEachReadAgainAtEachOfItsSitesEveryRoleAtTheSameLevelWithTheSameReasonsEachOnceAndTheSameFences =
	property.explore(
		aimed(sharedCaseGen, [
			["a read of an instance one other reads once, taking two modes", twoReachCaseGen]
		]),
		{
			needs: {},
			budget: { runs: 500, steered: 500 },
			situations: [
				"an instance read at two sites",
				"an instance read beneath a probe of its site",
				"an instance reading another",
				"a site probe of an instance read at two sites",
				"a role certified READ COMMITTED over an instance",
				"a role SERIALIZABLE",
				"a reason the expansion gives again",
				"an instance read taking two modes",
				"a read of an instance another reads, taking two modes",
				"a probe decided by its row path over an instance's reads",
				"a site probe of an instance read at two sites, decided by its row path",
				"a write joined with none of a CTE's read at two sites or arrivals",
				"a write joined with none of a read taking two modes",
				"an instance reading another, read at two sites, one beneath a probe",
				"a write joined with none of one query's read at two of its instances",
				"a write joined with none of an outside read taking two modes",
				"a read of an instance one other reads once, taking two modes"
			] satisfies ReadonlyArray<Reached<SharedFeature>>,
			check: (_2, k: CaseOf<SharedFeature>) => (c) =>
				Effect.sync(() => {
					for (const role of c.roles) {
						for (const st of Arr.flatten([...role.members, ...role.serializable])) {
							for (const feature of sharedFeatures(st)) {
								k.note(feature)
							}
						}
					}
					for (const role of c.roles) {
						for (const members of [role.members, role.serializable]) {
							const own = modesTaken(
								c,
								members,
								(st) => st,
								(_, at) => at
							)
							const sorted = (taken: ReadonlyArray<ModeTaken>): ReadonlyArray<string> =>
								Arr.sort(Arr.map(taken, modeKey), Order.String)
							assert.deepEqual(
								sorted(own),
								sorted(
									modesTaken(c, members, flatFacts, (st, at) => expanded(st).origins[at.read])
								),
								"each read takes the modes its reads again at each site take"
							)
							for (const feature of modeFeatures(members, own)) {
								k.note(feature)
							}
							for (const st of Arr.flatten(members)) {
								for (const feature of rowPathFeatures(sharedInput(c, flatFacts), st)) {
									k.note(feature)
								}
							}
						}
					}
					const plain: SharedCase = {
						...c,
						roles: Arr.map(c.roles, (r) => ({ ...r, serializable: [] }))
					}
					const counted = sharedCertified(plain, (st) => st)
					if (!counted.ok) {
						assert.fail("certification lowers every role")
					}
					for (const [i, role] of counted.value.roles.entries()) {
						const expected = unjoinedOracle(plain, i)
						assert.deepEqual(
							Arr.sort(
								Arr.filter(
									Arr.map(role.level === "serializable" ? reasonsOf(role.why) : [], unmaskedKey),
									(key) => Str.includes(unjoinedReason)(key)
								),
								Order.String
							),
							Arr.sort(Arr.dedupe(Arr.map(expected, (u) => u.key)), Order.String),
							`r${i}'s writes joined with none of some outside reads, each read counted once, each reason once`
						)
						if (Arr.some(expected, (u) => u.places < u.reads)) {
							k.note("a write joined with none of a CTE's read at two sites or arrivals")
						}
						if (Arr.some(expected, (u) => u.modes)) {
							k.note("a write joined with none of a read taking two modes")
						}
						if (Arr.some(expected, (u) => u.instances)) {
							k.note("a write joined with none of one query's read at two of its instances")
						}
						if (Arr.some(expected, (u) => u.outsideModes)) {
							k.note("a write joined with none of an outside read taking two modes")
						}
					}
					const shared = sharedCertified(c, (st) => st)
					const flat = sharedCertified(c, flatFacts)
					if (!shared.ok || !flat.ok) {
						assert.fail("certification lowers every role")
					}
					assert.deepEqual(shared.value.fences, flat.value.fences, "the fences")
					const keys = (reasons: ReadonlyArray<IsolationReason>): ReadonlyArray<string> =>
						Arr.dedupe(Arr.sort(Arr.map(reasons, reasonKey), Order.String))
					for (const [i, role] of shared.value.roles.entries()) {
						const other = Arr.getUnsafe(flat.value.roles, i)
						assert.equal(role.level, other.level, `r${i}'s level`)
						if (role.level === "serializable" && other.level === "serializable") {
							assert.deepEqual(
								keys(reasonsOf(role.why)),
								keys(reasonsOf(other.why)),
								`r${i}'s reasons, each once`
							)
							k.note("a role SERIALIZABLE")
							if (reasonsOf(other.why).length > keys(reasonsOf(other.why)).length) {
								k.note("a reason the expansion gives again")
							}
						}
						if (
							role.level === "readCommitted" &&
							Arr.some(Arr.flatten(Arr.getUnsafe(c.roles, i).members), (st) => st.uses.length > 0)
						) {
							k.note("a role certified READ COMMITTED over an instance")
						}
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "the certifier over the statements' expansions, each query CTE instance read again at each of its sites (test/support/expanded.ts)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\t\tfor (const r of fromReaches) {",
					replacement: "\t\t\tfor (const r of fromReaches.slice(0, 1)) {",
					why: "An instance reached from the first reach of the body that uses it alone; the second search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\t\t\t\t\t\t\t\tcore: use.core,",
					replacement: "\t\t\t\t\t\t\t\t\tcore: from.uses[0]?.core,",
					why: "A site probe judged in the core of its body's first use; the second search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\tif (!sameOrder(use.probes, chain.local)) {",
					replacement: "\tif (use.probes.length < 0) {",
					why: "A row path through a use beneath other probes than its chain; the second search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original: "\t\t\tif (instance !== undefined && !reached.has(use.cte)) {",
					replacement:
						"\t\t\tif (instance !== undefined && !reached.has(use.cte) && use.cte < 0) {",
					why: "No instance's read placed; the second search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						"\t\tconst known = seen.has([p.query, p.at.read])\n\t\tseen.add([p.query, p.at.read])",
					replacement:
						"\t\tconst known = seen.has([p.at.cte, p.at.read])\n\t\tseen.add([p.at.cte, p.at.read])",
					why: "A CTE's read counted once per instance; the second search fails."
				},
				{
					file: "packages/engine/src/analysis/isolation/certify.ts",
					original:
						"\tconst seen = new TupleSet<readonly [number | undefined, number]>()\n\treturn placed.filter((p) => {\n\t\tconst known = seen.has([p.query, p.at.read])\n\t\tseen.add([p.query, p.at.read])",
					replacement:
						"\tconst seen = new TupleSet<readonly [number | undefined, number, string]>()\n\treturn placed.filter((p) => {\n\t\tconst known = seen.has([p.query, p.at.read, p.mode])\n\t\tseen.add([p.query, p.at.read, p.mode])",
					why: "A read counted once per mode it takes; the second search fails."
				}
			]
		}
	)
