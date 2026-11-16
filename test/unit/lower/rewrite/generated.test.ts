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

/** Each rewrite pass preserves the delivered result on generated cases every pass alone, on cases of the population. */
export const eachRewritePassPreservesTheDeliveredResultOnGeneratedCasesEveryPassAloneOnCasesOfThePopulation =
	property.explore(
		(source) => ({
			pass: source.draw(element(passNames)),
			sketch: source.draw(sketchGen)
		}),
		{
			needs: {},
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
			kept: [],
			kills: []
		}
	)

/** Each rewrite pass preserves the delivered result on generated cases lateFetch over wide payload, where it fires. */
export const eachRewritePassPreservesTheDeliveredResultOnGeneratedCasesLateFetchOverWidePayloadWhereItFires =
	exploreCases({
		cases: wideCaseGen,
		passes: [lateFetchPass],
		evidence: "snapshot",
		situations: ["R06.lateFetch"],
		kept: [],
		kills: []
	})

/** Each rewrite pass preserves the delivered result on generated cases the composed pipeline over wide payload, in a transaction. */
export const eachRewritePassPreservesTheDeliveredResultOnGeneratedCasesTheComposedPipelineOverWidePayloadInATransaction =
	exploreCases({
		cases: wideCaseGen,
		passes: fullPipeline,
		evidence: "transaction",
		situations: [],
		kept: [],
		kills: []
	})

/** The composed rewrite phases preserve the delivered result demand, semantic simplification and relational rewrites in a snapshot read, firing every rule family. */
export const theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily =
	exploreSteered({
		passes: fullPipeline,
		evidence: "snapshot",
		situations: [...pipelineRules, "simplify.mergeProjections", "node Take"],
		aims: [
			["pushdown.semiSource", ["semiOver"]],
			["pushdown.semiGroup", ["semiOver"]],
			["simplify.mergeProjections", ["project"]],
			["node Take", ["match", "filter", "take"]]
		],
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:-:1.0.0.1.1.2.0.1.1.1.0.0.0.0.3.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.0.0.2.9.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.0.0.2.h.h.h.h.h.h.0.0.2.h.h.h.h.h"
				),
				reason: "a roster occurrence joined to a relation on its handle",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:-:1.0.0.0.1.2.0.0.0.0.0.0.3.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.0.3.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.0.1.0.0.0.0.0.0.0.0.0.0.0.2.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.0.0.2.h.h.h.h.h.h.0.0.2.h.h.h.h.h"
				),
				reason: "a filter equating two variables",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:-:1.0.0.0.2.1.0.0.0.0.0.3.0.1.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.6.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.0.0.2.h.h.h.h.h.h.0.0.2.h.h.h.h.h"
				),
				reason: "a match through a containment its foreign key makes redundant",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:-:1.0.0.0.1.2.0.0.0.0.0.0.3.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.0.8.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.0.0.2.h.h.h.h.h.h.0.0.2.h.h.h.h.h"
				),
				reason: "a filter on a group's key",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/lower/rewrite/generated.test.ts#theComposedRewritePhasesPreserveTheDeliveredResultDemandSemanticSimplificationAndRelationalRewritesInASnapshotReadFiringEveryRuleFamily:8000.f:1.0.0.0.1.2.0.0.0.0.0.0.3.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.3.0.0.1.0.0.0.1.0.0.0.1.0.0.0.1.0.0.1.0.2.0.1.0.2.0.1.0.2.0.1.0.2.0.0.2.0.3.0.2.0.3.0.2.0.3.0.2.0.3.0.0.0.3.8.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.h.0.0.2.h.h.h.h.h.h.1.0.0.2.h.h.0.h"
				),
				reason: "a filter over a take whose bound cuts a row the filter passes",
				since: "2026-11-14"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/pushdown/index.ts",
				original:
					'\t\t\tcase "Base":\n\t\t\tcase "Closed":\n\t\t\tcase "Context":\n\t\t\tcase "InputSet":\n\t\t\tcase "Delta":\n\t\t\tcase "Filter":\n\t\t\tcase "Take":',
				replacement:
					'\t\t\tcase "Take":\n\t\t\t\treturn overDemand(({ demand }) => {\n\t\t\t\t\tif (!exclusive(cx, demand, xCell) || x.correlation.length > 0) {\n\t\t\t\t\t\treturn false\n\t\t\t\t\t}\n\t\t\t\t\tconst moved = filterOver(cx.editor, x.input, cx.editor.copyExpr(m.filter.pred, cx.editor.retarget(xCell, x.input)))\n\t\t\t\t\ttakeOver(cx.editor, m, { ...x, input: moved })\n\t\t\t\t\tcertify(cx, pushdownRules.left, m, xCell.id, [m.cell.id, moved.id])\n\t\t\t\t\treturn true\n\t\t\t\t})\n\t\t\tcase "Base":\n\t\t\tcase "Closed":\n\t\t\tcase "Context":\n\t\t\tcase "InputSet":\n\t\t\tcase "Delta":\n\t\t\tcase "Filter":',
				why: "A filter moved below an uncorrelated take, so the take ranks other rows; the pipeline-snapshot-planted search fails at its kept filter over a take."
			}
		]
	})

/** The composed rewrite phases preserve the delivered result the same in a transaction, where only immediate evidence holds. */
export const theComposedRewritePhasesPreserveTheDeliveredResultTheSameInATransactionWhereOnlyImmediateEvidenceHolds =
	exploreSteered({
		passes: fullPipeline,
		evidence: "transaction",
		situations: [],
		aims: [],
		kept: [],
		kills: []
	})

/** The mutant suite's counterexample shapes, each root's cases through the composed pipeline in a snapshot read. */
export const theMutantSuitesCounterexampleShapes = family(
	Rec.map(
		{
			projectionsThatDropKeys: projectRoot,
			keyedJoins: keyedJoinRoot,
			fanoutJoins: fanoutJoinRoot,
			existentialWitnesses: witnessRoot,
			groups: groupRoot,
			projectionsBeforeAFold: projectGroupRoot,
			taggedUnions: taggedUnionRoot,
			untaggedUnions: untaggedUnionRoot,
			boundsUnderEXISTS: existsOverTakeRoot
		},
		(root) =>
			exploreCases({
				cases: rootedCaseGen(root, defaultGenConfig),
				passes: fullPipeline,
				evidence: "snapshot",
				situations: [],
				kept: [],
				kills: []
			})
	)
)
