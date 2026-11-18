/**
 * A unit-local rule over a query is judged whole (analysis/theory/unit.ts, physical/ddl/rules.ts addRules): every
 * relation it reads immutable and leading its key with one unit key, which every rule of its violation query joins on,
 * the judge reads its violation query, the one the migration that adds it runs, over the units a transaction wrote. On
 * PostgreSQL 19rc2, over a whole judge and its probed twin of each unit shape (rule-whole.fixtures.ts): nodes and
 * expressions keyed by their document's place first, one, two or three fields of it, declared in the key's order or
 * reversed, under a containment of a join into a table, a check over a join, a key over a projection of it, and, in
 * the whole judge alone, which no probe reads: a check over an aggregate of each node's children, a containment into
 * a recursion over the parent links, and a check over a negation of a query that negates in turn.
 *
 * - **equivalence**: a schedule of direct SQL transactions at SERIALIZABLE over two documents, each a unit, run on both
 *   judges of a drawn shape in lockstep: inserts and deletes of single rows, a document written whole and one dropped whole, with the
 *   judge run inside a transaction that then writes on. At each judge and at each transaction's end each judge refuses
 *   exactly when its rules' whole checks, the violation queries a migration runs over every row, find the state
 *   broken, naming a rule they find broken; and the whole judge refuses exactly where the probed judge, the one rules
 *   that are not unit-local keep, refuses, wherever the aggregate's rule holds.
 * - **locality**: hundreds of documents stored, analyzed or not, beside one a transaction writes whole: each whole
 *   rule's statement reads the same rows when as many documents again are stored, the written document's alone; and
 *   with tens of documents written, then four times as many, its work grows with the units written, not with their
 *   square, since the unit is bound once, by the outermost rule that reads it (analysis/theory/unit.ts Restriction).
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	judgeTemplates,
	localityGen,
	runEquivalence,
	runLocality,
	wholeFeatures,
	wholeSpace
} from "#test/pg/laws/rule-whole.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The whole judge refuses exactly the transactions whose state a rule's whole check finds broken, as the probed judge
 * does wherever both judge the same rules.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aUnitLocalRuleIsJudgedWholeOverTheUnitsATransactionWroteAsItsWholeCheckAndItsProbesJudgeIt =
	property.explore(wholeSpace, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.freshOf),
		situations: wholeFeatures,
		check: (judges, c) => (schedule) =>
			Effect.gen(function* () {
				const w = yield* judges[`whole ${schedule.shape}`]
				const p = yield* judges[`probed ${schedule.shape}`]
				const ws = yield* w.substrate.session({ ...ownerSession(), label: "whole judge" })
				const ps = yield* p.substrate.session({ ...ownerSession(), label: "probed judge" })
				yield* runEquivalence(
					{ installed: w.value, session: ws },
					{ installed: p.value, session: ps },
					schedule,
					c
				)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "every rule's whole violation query, the migration's check over every row, and the probed judge of the same rules: the whole judge refuses exactly the states one finds broken, naming a rule it finds broken, and where the probed judge refuses"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\t...(of.some((r) => r.polarity !== "positive") ? ["removed" as const] : [])',
				replacement: "\t\t\t...[]",
				why: "The region holds no unit a delete removed rows of, so an expression's delete under its member, or a child's under a node of kind 2, is never judged, and a transaction that breaks Rooted or Fanout commits."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\tp === "positive" ? "negative" : p === "negative" ? "positive" : "both"',
				replacement: "\tp",
				why: "A relation a negation reads keeps its polarity, so a containment's target is read on its side of news alone and its delete captures nothing: an expression removed under its member is never judged."
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
 * them, with statistics or none, and its work grows with the units written.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWholeRulesStatementReadsTheUnitsATransactionWroteAloneBesideAnyNumberOfStoredUnits =
	property.explore(localityGen, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.rolledBack),
		situations: ["measured with no statistics", "measured analyzed"],
		check: (judges, c) => (drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* judges[`whole ${drawn.shape}`]
				yield* runLocality(value, connection, drawn, c)
			}),
		oracle: {
			kind: "universal",
			name: "bound: a whole rule's statement reads fewer rows than the documents stored beside the written one, however many stand beside it, and its work grows under twice as fast as the documents written"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\tw.restrict.kind === "region" &&',
				replacement: "\t\tfalse &&",
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
					'\tconst inner: Walk = region === undefined ? w : { ...w, restrict: { kind: "bound", region } }',
				replacement: "\tconst inner: Walk = w",
				why: "A rule read per unit binds no unit for the rules its imports and negations read, so each matches the region again inside the step, once per written unit: Leafed's leaves and Reached's walk read the region's every unit for each, and the statement's work grows with the square of the units written."
			}
		]
	})
