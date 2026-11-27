/**
 * A unit-local rule over a query is judged whole (analysis/theory/unit.ts, physical/ddl/rules.ts addRules): every
 * relation it reads immutable and leading its key with one unit key, which every rule of its violation query joins on,
 * the judge reads its violation query, the one the migration that adds it runs, over the units a transaction wrote. On
 * PostgreSQL 19, over a whole judge and its probed twin of each unit shape (rule-whole.fixtures.ts): nodes and
 * expressions keyed by their document's place first, one, two or three fields of it, declared in the key's order or
 * reversed, under a containment of a join into a table, a check over a join, a key over a projection of it, two
 * containments between selected sides of the stored relations, whole in the whole judge and native foreign keys in
 * its twin (laws/model/plan.ts ContainmentDischarge), and, in the whole judge alone, which no probe reads: a check over an aggregate of each node's children, a containment into
 * a recursion over the parent links seeded from the roots, a union of two rules the containment's target reads again
 * beside the recursion, and a check over a negation of a query that negates in turn.
 *
 * - **equivalence**: a schedule of direct SQL transactions at SERIALIZABLE over two documents, each a unit, run on both
 *   judges of a drawn shape in lockstep: inserts and deletes of single rows, a document written whole and one dropped whole, with the
 *   judge run inside a transaction that then writes on. A transaction that deletes a row is the whole judge's data
 *   step, its relations closed, inside the bracket a migration's runner sends (data-step.ts dataStepOf), judged at its
 *   end alone by the bracket's checks, the judge and the re-check, which refuses a step that breaks a rule under 23000
 *   and the rule's law, the judge reading none of a closed relation's removed rows; on the probed judge, its relations
 *   mutable, a served write. At each judge and at each transaction's end each judge refuses
 *   exactly when its rules' whole checks, their violation queries lowered by the oracle baseline, find the state
 *   broken, naming a rule they find broken; each rule's check over every row, the judge of the transaction that
 *   writes every row, which the migration that adds the rule runs (deploy/snapshot/violation.ts lawChecks), finds a
 *   row exactly when its whole check does; and the whole judge refuses exactly where the probed judge, the one rules
 *   that are not unit-local keep, refuses, wherever the aggregate's rule holds.
 * - **narrowed region**: Marks joins Tag and Node at Node's key, Tag contained in Node there, so its region reads a
 *   node a transaction wrote only where it replaces one the transaction removed (analysis/theory/unit.ts proofsOf),
 *   and Kinded's KindOne matches a node at kind 1 beside its expression, Expressed holding every node of kind 1 or 2
 *   in Expr, so its region reads an expression written only where it replaces one: the equivalence holds the narrowed
 *   regions to the whole checks, a node replaced under its tag and an expression written at a node that stood before
 *   among its cases, and a transaction that writes documents whole beside a few tags reads Tag once per tag, never
 *   once per node.
 * - **locality**: hundreds of documents stored, analyzed or not, beside one a transaction writes whole: each whole
 *   rule's statement reads the same rows when as many documents again are stored, the written document's alone; and
 *   with tens of documents written, then four times as many, each node it runs once per unit reads that unit alone,
 *   so its work grows with the units written, not with their square, since the unit is bound once, by the outermost
 *   rule that binds it (analysis/theory/unit.ts Restriction).
 * - **commuting units**: thousands of documents stored and committed, then two transactions at SERIALIZABLE each writing
 *   a document of its own, one left of every stored one and one right of them, both open before either commits: neither
 *   judge holds a SIRead lock on all of Node, Expr or an index of theirs, and both commit, each judge read per unit
 *   of its region.
 */
import { family, type Kill, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import {
	commuteGen,
	commuteTemplates,
	judgeTemplates,
	localityGen,
	narrowedGen,
	runCommute,
	runEquivalence,
	runLocality,
	runNarrowed,
	shapeKeys,
	storedTemplates,
	wholeFeatures,
	wholeSpace
} from "#test/pg/laws/rule-whole.fixtures.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The whole judge refuses exactly the transactions whose state a rule's whole check finds broken, as the probed judge
 * does wherever both judge the same rules.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aUnitLocalRuleIsJudgedWholeOverTheUnitsATransactionWroteAsItsWholeCheckAndItsProbesJudgeIt =
	property.explore(wholeSpace, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.fresh),
		situations: wholeFeatures,
		check: (judges, c) => (schedule) =>
			Effect.gen(function* () {
				const w = yield* judges[`whole ${schedule.shape}`]
				const p = yield* judges[`probed ${schedule.shape}`]
				const ws = yield* w.substrate.session({ ...ownerSession(), label: "whole judge" })
				yield* standUpJudge(ws, w.value.installation)
				const ps = yield* p.substrate.session({ ...ownerSession(), label: "probed judge" })
				yield* standUpJudge(ps, p.value.installation)
				yield* runEquivalence(
					{ installed: w.value, session: ws },
					{ installed: p.value, session: ps },
					schedule,
					c
				)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "every rule's whole violation query, lowered by the oracle baseline, and the probed judge of the same rules: the whole judge refuses exactly the states one finds broken, naming a rule it finds broken, and where the probed judge refuses, and each rule's check over every row finds a row exactly where its whole check does"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\t\t\treturn side === "removed"\n\t\t\t\t? { kind: "empty" }',
				replacement:
					'\t\t\treturn side === "removed" || side === "added"\n\t\t\t\t? { kind: "empty" }',
				why: "A rule's check over every row reads none of the rows the transaction that writes every row adds, so it finds nothing in a state its whole check finds broken, and a migration installs a rule the stored rows break."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t\t\t\treturn judgedPlan(law, discharge.rule)",
				replacement: "\t\t\t\t\t\treturn done([])",
				why: "A containment the rule judge holds installs nothing and the judge holds nothing of it, so a transaction that breaks Expressed or Parented commits, which its native twin refuses."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\tconst implied = held.filter((h) =>\n\t\th.selection.every((conjunct) => implies(where(h.beside), conjunct))\n\t)",
				replacement: "\tconst implied = held",
				why: "A containment from a selection of its source proves an occurrence beside one that reads rows outside the selection, so Expressed, which holds the nodes of kind 1 or 2 in Expr, proves Typed's expressions read where they replace one alone, beside nodes of every kind: an expression written at a node of kind 0 that stood before, the node's parent no expression's, is never judged, and a transaction that breaks Rooted commits."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tfor (const side of sidesAt(r.polarity)) {",
				replacement: "\t\tfor (const side of at === undefined ? sidesAt(r.polarity) : []) {",
				why: "A proved occurrence reads no row its relation gained, not even one that replaces a row it lost, so a node replaced under its tag by one of kind 1 is never judged, and a transaction that breaks Marked commits."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: `\t\t\t\tbind: Object.fromEntries(unit.map((v, j) => [\`unit\${j}\`, varRef(v.id)] as const))`,
				replacement: `\t\t\t\tbind: Object.fromEntries(unit.map((v, j) => [\`unit\${j}\`, varRef(unit[(j + 1) % unit.length]?.id ?? v.id)] as const))`,
				why: "A rule read per unit takes each field of its unit key at the next field's channel, so a unit of two or three place fields reads its doc at its sub, which no row of the document holds: the step reads nothing for the unit, and a transaction that breaks a rule over a key of several place fields commits."
			}
		]
	})

/**
 * Each whole rule's statement reads the rows of the units a transaction wrote alone, however many units stand beside
 * them, with statistics or none, and its work grows with the units written, not with their square.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
/** The kills of the locality, each family member's: any shape's judge reads the units written alone. */
const localityKills: ReadonlyArray<Kill> = [
	{
		file: "packages/engine/src/analysis/theory/unit.ts",
		original:
			'\t\t\trestriction.kind === "region" ? unitStep(walkedText, unit, restriction.region) : walkedText,',
		replacement: "\t\t\twalkedText,",
		why: "No rule of a whole rule's violation query matches the region of the units a transaction wrote, so the judge reads every unit stored, and a write of one document reads every document."
	},
	{
		file: "packages/engine/src/analysis/theory/unit.ts",
		original: "\tconst restrict = w.restrict",
		replacement: "\tconst restrict: Restriction = deciding",
		why: "A recursion is read whole rather than per unit, its seeds and steps at no channel, so Reached's walk reads every document's nodes for a write of one."
	},
	{
		file: "packages/engine/src/analysis/theory/unit.ts",
		original:
			'\t\t\t? ruleBody(r, at, aggregates, {\n\t\t\t\t\t...w,\n\t\t\t\t\trestrict: { kind: "bound", region: restriction.region }\n\t\t\t\t})',
		replacement: "\t\t\t? ruleBody(r, at, aggregates, w)",
		why: "A rule read per unit binds no unit for the rules its imports and negations read, so each matches the region again inside the step, once per written unit, or beside it, Rooted's two sides each over a region of its own: a node run once per unit reads every written unit's rows at each run, and the statement's work grows with the square of the units written."
	}
]

export const aWholeRulesStatementReadsTheUnitsATransactionWroteAloneBesideAnyNumberOfStoredUnits =
	family(
		Rec.fromEntries(
			Arr.map(shapeKeys, (shape) => {
				const templates = storedTemplates(shape)
				return [
					shape,
					property.explore(localityGen(shape), {
						needs: {
							stored: Substrate.rolledBack(templates.stored),
							more: Substrate.rolledBack(templates.more)
						},
						situations: ["measured with no statistics", "measured analyzed"],
						check: (needs, c) => (drawn) =>
							Effect.gen(function* () {
								const stored = yield* needs.stored
								const more = yield* needs.more
								yield* runLocality(
									{ installed: stored.value, connection: stored.connection },
									{ installed: more.value, connection: more.connection },
									drawn,
									c
								)
							}),
						oracle: {
							kind: "universal",
							name: "bound: a whole rule's statement reads fewer rows than the documents stored beside the written one, however many stand beside it, and each node it runs more than once reads fewer rows a run than the documents written"
						},
						kept: [],
						kills: localityKills
					})
				] as const
			})
		)
	)

/**
 * Two transactions each writing a unit of its own beside thousands stored both commit at SERIALIZABLE, and neither's
 * judge locks all of a relation the other writes: each whole rule's statement is read per unit of the region its
 * transaction wrote (analysis/theory/unit.ts unitStep), so it reads its own unit's rows and the two share no page a
 * judge reads and the other writes. metis's concurrent pantry imports, each of its own package, failed each other with
 * 40001 (2026-11-21), each import's judge reading every package. The roots this judge reads twice are inlined at each
 * read, inside Reached's recursion and in Reach's second arm, each correlated to the unit, no one node a key set
 * computes (lower/shapes/share/keys.ts); test/unit/physical/judge-units is the proof of a node shared across those
 * reads, computed at the units' keys.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const twoTransactionsEachWritingAUnitOfItsOwnBothCommitAndNeithersJudgeLocksARelationTheOtherWrites =
	property.explore(commuteGen, {
		needs: Substrate.oneOf(commuteTemplates, Substrate.fresh),
		situations: ["two units written at once, both committed"],
		check: (templates, c) => (drawn) =>
			Effect.gen(function* () {
				const w = yield* templates[drawn.shape]
				const first = yield* w.substrate.session({ ...ownerSession(), label: "first unit" })
				yield* standUpJudge(first, w.value.installation)
				const second = yield* w.substrate.session({ ...ownerSession(), label: "second unit" })
				yield* standUpJudge(second, w.value.installation)
				yield* runCommute(w.value, first, second, drawn, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's SSI and its pg_locks: no SIRead lock of either judge on all of Node, Expr or an index of theirs, and both transactions committed"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\trestriction.kind === "region" ? unitStep(walkedText, unit, restriction.region) : walkedText,',
				replacement: "\t\t\twalkedText,",
				why: "No rule of a whole rule's violation query is read per unit of the region the transaction wrote, so each judge reads every document stored, the other transaction's rows' pages among them, and the two transactions read what each other writes: PostgreSQL refuses one with 40001."
			}
		]
	})

/**
 * A whole rule over a join of a contained relation and the keyed relation it is contained in reads the contained
 * relation once per row it gained, never once per row the keyed one gained.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWholeRuleOverAContainedRelationsJoinReadsItOncePerRowItGainedNeverOncePerRowItsContainerGained =
	property.explore(narrowedGen, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.rolledBack),
		situations: ["documents written whole beside a few tags"],
		check: (judges, c) => (drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* judges[`whole ${drawn.shape}`]
				yield* runNarrowed(value, connection, drawn, c)
			}),
		oracle: {
			kind: "universal",
			name: "bound: each scan of Tag in a whole rule's statement runs at most once per tag the transaction wrote, beside three nodes a document"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\tif (side === "removed" ? closed || withdrawn.has(place) : proofs.has(place)) {',
				replacement: '\t\t\tif (side === "removed" ? closed || withdrawn.has(place) : false) {',
				why: "Marks's region reads every node a transaction wrote, so its statement reads Tag once per node, three a document, where it read it once per tag."
			},
			{
				file: "test/support/judge.ts",
				original: "\t\tconst temporary = yield* values(",
				replacement:
					'\t\tyield* values("SET CONSTRAINTS ALL IMMEDIATE")\n\t\tconst temporary = yield* values(',
				why: "The judge's statements explained after the judge has run, as every property explained them after SET CONSTRAINTS ALL IMMEDIATE until e8de84026 made each part delete the delta rows it reads: every scan of Tag reads empty deltas, 0 loops, so the bound held over no rows whatever Marks's region read; the measurement is refused, no judged statement reading a delta row."
			}
		]
	})
