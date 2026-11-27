/**
 * Every rewrite pass, alone and composed, preserves what the query delivers over generated cases: the rewritten DAG
 * validates, lowers conservatively with every statement passing the structural audit, and the reference evaluator
 * computes the same statements, headings and row sets for it as for the original. A delivered term the reference
 * declines, such as a vector's distance, is compared as its term (reference/values.ts Declined), which the rewritten
 * query must deliver over the same values.
 *
 * The cases are the optimizer's population for the rewrite passes (gen/case.ts rewriteGenConfig), its wide payload
 * text alone, every carrier still in its palette, and with filters drawn directly over groups, unions and set
 * comparisons, whose schemas declare containments as native foreign keys that their facts satisfy (gen/schema.ts) and
 * whose queries read through them, so R03 runs against the immediate foreign keys a generated installation has; its
 * wide payload under takes with stated orders lets R06 late fetch fire on generated cases, and the hand-built
 * wide-payload cases (wide.ts) hold it to the transaction context too. No pass and no lowering refuses a generated
 * case: a refusal fails it.
 *
 * The population is steered: while a required feature is unreached, a case that reached a feature or pair no earlier
 * case reached is kept, and later cases mutate kept ones. The features are semantic: each rule fired, each rule paired
 * with the kind of node it rewrote, and each kind of node the query holds. The rule families the population must reach
 * are the composed pipeline's required features; those it reaches only a few times a run are planted, as kept cases of
 * the same population.
 *
 * Oracle: the reference evaluator's delivery of the query before the passes (a second implementation), and the strict
 * DAG re-reader beside the conservative lowering's audit.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, family, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { lateFetchPass } from "#compiler/lower/optimize/late-fetch/index.ts"
import { defaultGenConfig, resolveQueryCase } from "#test/support/oracle/gen/case.ts"
import {
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	keyedJoinRoot,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	untaggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"
import {
	exploreCases,
	exploreSteered,
	fullPipeline,
	passNames,
	pipelineRules,
	population,
	preserves,
	singlePasses,
	type SinglePassFeature,
	sketchGen
} from "#test/unit/lower/rewrite/generated.fixtures.ts"
import { wideCaseGen } from "#test/unit/lower/rewrite/wide.ts"

/**
 * Each rewrite pass preserves the delivered result on generated cases every pass alone, on cases of the population.
 *
 * Budget: 150 runs and 150 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/generated.test.ts:477 at 8cad5bce, its runs and its coverage's cases).
 */
export const eachRewritePassPreservesTheDeliveredResultOnGeneratedCasesEveryPassAloneOnCasesOfThePopulation =
	property.explore(
		(source) => ({
			pass: source.draw(element(passNames)),
			sketch: source.draw(sketchGen)
		}),
		{
			needs: {},
			budget: { runs: 150, steered: 150 },
			situations: Arr.map(
				passNames,
				(name): SinglePassFeature => `pass ${name}`
			) satisfies ReadonlyArray<Reached<SinglePassFeature>>,
			check:
				(_, c: Case<SinglePassFeature>) =>
				({ pass, sketch }) =>
					Effect.sync(() => {
						c.note(`pass ${pass}`)
						preserves(
							c.draw(resolveQueryCase(sketch, population)),
							singlePasses[pass],
							"snapshot",
							c
						)
					}),
			oracle: {
				kind: "second-implementation",
				name: "the reference evaluator's delivery of the query before the passes"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/lower/rewrite/generated.test.ts#eachRewritePassPreservesTheDeliveredResultOnGeneratedCasesEveryPassAloneOnCasesOfThePopulation:7f.6:0.1.1.0.4.2.0.0.0.0.0.1.0.0.1.0.0.0.0.1.0.0.1.0.0.0.0.1.0.0.1.0.0.0.0.1.0.0.0.0.0.0.1.3.2.2.2.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.1.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.1.1.3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.1.0.0.1.2.2.2.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.2.0.2.0.0.2.0.0.0.0.0.0.0.0.4.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.1.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.5.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1"
					),
					reason:
						"a conditional of text ~ /^.*$/u whose other branch is text ~ /^.{0,2}$/su, coerced into it with no node of its own since bbfa4eca06 (a refined text's entered type subsumes it), which the DAG's rule refused as a branch of neither the conditional's type nor its entered type (the merged tree's floor stream, seed 0x6149ccb1, case 15): a branch stands at a type either subsumes (ir/expr.ts condProblems)",
					since: "2026-11-26"
				}
			],
			kills: [
				{
					file: "packages/engine/src/ir/expr.ts",
					original: "\t\t[t, e].every((b) => typed.some((branch) => subsumes(branch, b.type)))\n",
					replacement:
						"\t\t[t, e].every((b) => typed.some((branch) => sameScalarType(b.type, branch)))\n",
					why: "A conditional's branch held to the conditional's type or its entered type by equality, where a coercion into it builds no node for a branch either subsumes: the kept case's refined branch breaks the DAG's rule."
				},
				{
					file: "packages/engine/src/logical/props.ts",
					original: "\t\twhile (edge !== undefined) {",
					replacement: "\t\twhile (edge === undefined) {",
					why: "Operator mutant dc818727b1 at packages/engine/src/logical/props.ts:1244 in evert: `!==` becomes `===`; the property fails (the census, lane TESTPOLICY2)."
				}
			]
		}
	)

/**
 * Each rewrite pass preserves the delivered result on generated cases lateFetch over wide payload, where it fires.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/generated.test.ts:516 at 8cad5bce, its runs and its coverage's cases).
 */
export const eachRewritePassPreservesTheDeliveredResultOnGeneratedCasesLateFetchOverWidePayloadWhereItFires =
	exploreCases({
		budget: { runs: 200, steered: 200 },
		cases: wideCaseGen,
		passes: [lateFetchPass],
		evidence: "snapshot",
		situations: ["R06.lateFetch"],
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original:
					"\treturn distinct.length === 0 ? noIds : Object.freeze(distinct.toSorted(compareStrings))",
				replacement:
					"\treturn distinct.length === 1 ? noIds : Object.freeze(distinct.toSorted(compareStrings))",
				why: "Operator mutant (bound) at packages/engine/src/ir/expr.ts:563 in sortedUnique: `0` becomes `1`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Each rewrite pass preserves the delivered result on generated cases the composed pipeline over wide payload, in a
 * transaction.
 *
 * Budget: 100 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/generated.test.ts:516 at 8cad5bce, its runs and its coverage's cases).
 */
export const eachRewritePassPreservesTheDeliveredResultOnGeneratedCasesTheComposedPipelineOverWidePayloadInATransaction =
	exploreCases({
		budget: { runs: 100, steered: 0 },
		cases: wideCaseGen,
		passes: fullPipeline,
		evidence: "transaction",
		situations: [],
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/dfa.ts",
				original: "\t\tthis.#marked[s] = at(this.#marked, s) + 1",
				replacement: "\t\tthis.#marked[s] = at(this.#marked, s) + 2",
				why: "Operator mutant c78ce76fd9 at packages/text/src/regex/dfa.ts:238 in <module>: `1` becomes `2`, restated on the refinable partition of the minimization's live states (dfa.ts Refinable mark); the property fails (the census, lane TESTPOLICY2; restated by lane SCHEMAPERF)."
			}
		]
	})

/**
 * The composed rewrite phases preserve the delivered result demand, semantic simplification and relational rewrites in
 * a snapshot read, firing every rule family.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/generated.test.ts:546 at 8cad5bce, its runs and its coverage's cases).
 */
export const theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily =
	exploreSteered({
		budget: { runs: 400, steered: 400 },
		passes: fullPipeline,
		evidence: "snapshot",
		situations: [...pipelineRules, "simplify.mergeProjections", "node Take"],
		aims: [
			["simplify.mergeProjections", ["project"]],
			["node Take", ["match", "filter", "take"]]
		],
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:-:1.0.0.1.1.2.0.1.1.1.0.0.0.0.1.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.0.0.2.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.0.0.2.3.3.3.3.3.3.0.0.2.3.3.3.3.3"
				),
				reason: "a roster occurrence joined to a relation on its handle",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:-:1.0.0.0.1.2.0.0.0.0.0.0.1.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.2.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.0.0.2.3.3.3.3.3.3.0.0.2.3.3.3.3.3"
				),
				reason: "a filter equating two variables",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:-:1.0.0.0.2.1.0.0.0.0.0.1.0.1.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.0.0.2.3.3.3.3.3.3.0.0.2.3.3.3.3.3"
				),
				reason: "a match through a containment its foreign key makes redundant",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:-:1.0.0.0.1.2.0.0.0.0.0.0.1.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.0.2.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.3.0.0.2.3.3.3.3.3.3.0.0.2.3.3.3.3.3"
				),
				reason: "a filter on a group's key",
				since: "2026-10-29"
			}
		],
		kills: []
	})

/**
 * The composed rewrite phases preserve the delivered result the same in a transaction, where only immediate evidence
 * holds.
 *
 * Budget: 200 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/generated.test.ts:576 at 8cad5bce, its runs and its coverage's cases).
 */
export const theComposedRewritePhasesPreserveTheDeliveredResultTheSameInATransactionWhereOnlyImmediateEvidenceHolds =
	exploreSteered({
		budget: { runs: 200, steered: 0 },
		passes: fullPipeline,
		evidence: "transaction",
		situations: [],
		aims: [],
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: 'r.kind === "derived" && level === 0',
				replacement: "level === 0",
				why: 'Operator mutant 192e2aba66 at packages/engine/src/schema/own.ts:1331 in <module>: `r.kind === "derived" && level === 0` becomes `level === 0`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})

/**
 * The mutant suite's counterexample shapes, each root's cases through the composed pipeline in a snapshot read.
 *
 * Budget: 120 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/generated.test.ts:603 at 8cad5bce, its runs and its coverage's cases).
 */
export const theMutantSuitesCounterexampleShapes = family(
	Rec.map(
		{
			projectionsThatDropKeys: {
				root: projectRoot,
				kills: [
					{
						file: "packages/text/src/base/nonempty.ts",
						original: "[...appendNonEmpty(rest.slice(0, cut), head), ",
						replacement: "[",
						why: "Operator mutant 046d37f796 at packages/text/src/base/nonempty.ts:53 in sortNonEmpty: `[...appendNonEmpty(rest.slice(0, cut), head), ` becomes `[`; the property fails (the census, lane TESTPOLICY2)."
					}
				]
			},
			keyedJoins: {
				root: keyedJoinRoot,
				kills: [
					{
						file: "packages/text/src/regex/partition.ts",
						original: "\t\t\tif (listed[atom] !== s) {",
						replacement: "\t\t\tif (listed[atom] === s) {",
						why: "Operator mutant b006bb2f7e at packages/text/src/regex/partition.ts:108 in partitionOf: `!==` becomes `===`; the property fails (the census, lane TESTPOLICY2)."
					}
				]
			},
			fanoutJoins: {
				root: fanoutJoinRoot,
				kills: [
					{
						file: "packages/text/src/regex/ir.ts",
						original: "\t!((p & passesEnd) !== 0 && (q & consumes) !== 0)",
						replacement: "\t!((p & passesEnd) !== 1 && (q & consumes) !== 0)",
						why: "Operator mutant f0334a50e2 at packages/text/src/regex/ir.ts:169 in canFollow: `0` becomes `1`; the property fails (the census, lane TESTPOLICY2)."
					}
				]
			},
			existentialWitnesses: {
				root: witnessRoot,
				kills: [
					{
						file: "packages/engine/src/sql/naming.ts",
						original:
							'\toperand.kind === "core" ? renameCore(operand, heading) : renameSelect(operand, heading)',
						replacement:
							'\toperand.kind !== "core" ? renameCore(operand, heading) : renameSelect(operand, heading)',
						why: "Operator mutant a9c352994a at packages/engine/src/sql/naming.ts:263 in renameOperand: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
					}
				]
			},
			groups: {
				root: groupRoot,
				kills: [
					{
						file: "packages/engine/src/ir/shape.ts",
						original: "keys.every((key) => Object.hasOwn(o, key))",
						replacement: "false",
						why: "Operator mutant 2b4beb9152 at packages/engine/src/ir/shape.ts:931 in complete: `keys.every((key) => Object.hasOwn(o, key))` becomes `false`; the property fails (the census, lane TESTPOLICY2)."
					}
				]
			},
			projectionsBeforeAFold: {
				root: projectGroupRoot,
				kills: [
					{
						file: "packages/engine/src/schema/representability.ts",
						original:
							"\tconst gist = span === undefined ? Result.ok(undefined) : spanKeyGist(datums, span)",
						replacement:
							"\tconst gist = span !== undefined ? Result.ok(undefined) : spanKeyGist(datums, span)",
						why: "Operator mutant a8c3c62e50 at packages/engine/src/schema/representability.ts:1063 in keyLayout: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
					}
				]
			},
			taggedUnions: {
				root: taggedUnionRoot,
				kills: [
					{
						file: "packages/engine/src/sql/transform.ts",
						original: 'return this.setOp(b)\n\t\t\tcase "select":\n\t\t\t\treturn this.select(b)',
						replacement: 'return this.select(b)    case "select":     return this.setOp(b)',
						why: 'Operator mutant 01b09889e6 at packages/engine/src/sql/transform.ts:634 in <module>: `return this.setOp(b)    case "select":     return this.select(b)` becomes `return this.select(b)    case "select":     return this.setOp(b)`; the property fails (the census, lane TESTPOLICY2).'
					}
				]
			},
			untaggedUnions: {
				root: untaggedUnionRoot,
				kills: [
					{
						file: "packages/pg/src/pin.ts",
						original: 'line === "" || Str.startsWith("#")(line)',
						replacement: 'Str.startsWith("#")(line)',
						why: 'Operator mutant 1ca3593b90 at packages/pg/src/pin.ts:71 in assignments: `line === "" || Str.startsWith("#")(line)` becomes `Str.startsWith("#")(line)`; the property fails (the census, lane TESTPOLICY2).'
					}
				]
			},
			boundsUnderEXISTS: {
				root: existsOverTakeRoot,
				kills: [
					{
						file: "packages/engine/src/ir/fold.ts",
						original: "\t\t\tif (next.done === true) {",
						replacement: "\t\t\tif (next.done !== true) {",
						why: "Operator mutant 2b80db5b5f at packages/engine/src/ir/fold.ts:46 in <module>: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
					}
				]
			}
		},
		({ root, kills }) =>
			exploreCases({
				budget: { runs: 120, steered: 0 },
				cases: rootedCaseGen(root, defaultGenConfig),
				passes: fullPipeline,
				evidence: "snapshot",
				situations: [],
				kept: [],
				kills
			})
	)
)
