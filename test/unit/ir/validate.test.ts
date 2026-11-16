/**
 * The DAG validator (test/support/oracle/dag-validate.ts validateTable and dagProblems), the checker every artifact this
 * package builds is held to, over the every-kind fixture, generated DAGs and their live variants, each broken by one
 * named corruption (test/unit/ir/corruptions.ts) at any of its sites.
 *
 * - A live DAG and every live variant of it is accepted and comes back validated.
 * - A corrupted one is a defect naming the first problem the validator reports, its place's label and path and its
 *   rule, and the problem its site expects is among those reported, at the corruption's place or within it: a problem
 *   under the corruption's own rule; under another the site names, where breaking its own breaks that one and the
 *   validator holds its own nowhere else; or the shape stage's refusal, where the value breaks the table's shape.
 *
 * Oracle: each corruption's rule restated over the table, and the place it breaks, compared by label and path.
 *
 * Features: live, every corruption's rule beside the site it broke, and every node kind a live DAG holds.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { corruptedFeature } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { relKinds } from "#compiler/ir/rel.ts"
import {
	aimedCase,
	corruptionOf,
	type DagFeature,
	drawnCase,
	judged,
	liveFrom,
	ruleFeatures
} from "#test/unit/ir/validate.fixtures.ts"

/** ValidateDag accepts every live DAG and its live variants, and raises a defect for each one a corruption breaks at any site. */
export const validateDagAcceptsEveryLiveDAGAndItsLiveVariantsAndRaisesADefectForEachOneACorruptionBreaksAtAnySite =
	property.explore(
		aimed(drawnCase, [
			...Arr.map(relKinds, (k) => [`node ${k}`, aimedCase({ kind: "live" })] as const),
			...Arr.map(ruleFeatures, (rule) => [rule, aimedCase({ kind: "rule", rule })] as const)
		]),
		{
			needs: {},
			situations: [
				"live",
				...ruleFeatures,
				...Arr.map(relKinds, (k): DagFeature => `node ${k}`)
			] satisfies ReadonlyArray<Reached<DagFeature>>,
			check:
				(_, n: Case<DagFeature>) =>
				([table, choice, aim]) =>
					Effect.sync(() => {
						const live = liveFrom(table, choice)
						if (live.variant.kind === "at") {
							n.note(`variant ${live.variant.at}`)
						}
						const c = corruptionOf(live.dag, aim, n.draw)
						n.note(corruptedFeature(c))
						if (c.kind !== "live") {
							n.pair(corruptedFeature(c), `site ${c.at}`)
						}
						const validated = judged(c)
						for (const node of validated === undefined ? [] : Rec.values(validated.nodes)) {
							n.note(`node ${node.kind}`)
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "each corruption's rule restated over the table"
			},
			kept: [],
			kills: []
		}
	)
