/**
 * Merging is exact (w4-w7 §2.1, fin.md §15 rule 3): a family axis's one foreign key, carrying every containment that
 * rides it, holds in a state exactly when every one of those containments holds there. The oracle is metamorphic: the
 * merged lowering's verdict against each containment's own meaning as a partial projection, a source side's every
 * defined tuple among the target side's tuples, computed directly from the state. It is exact because the axis's key
 * terms are a key of its target side, so a source row meets at most one target row; the host model of the foreign key's
 * PostgreSQL semantics (natives.ts `breaks`, MATCH SIMPLE) is the judge.
 *
 * Bound: an owner's family of two members at slots 0 and 1, with two copies riding one axis: the owner axis (o₀ → f₀
 * and o₁ → f₁ from each member to its owner), the predecessor axis (a₀ → b₀ and a₁ → b₁ between neighbours) or the last
 * axis (e₀ → l₀ and e₁ → l₁ from the owner to its last member), every carried column over the three values 0, 1 and 2:
 * 3⁶, 3⁸ and 3⁶ states, exhausted. Every state holds the family itself, so the axis's key part holds and each verdict
 * turns on the copies.
 *
 * Features: each axis, and each copy's verdict.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { breaks } from "#test/support/unit/laws/model/natives.ts"
import {
	axisKey,
	copyHolds,
	type Feature,
	mergeGen,
	models,
	stateOf,
	type Verdict,
	verdicts
} from "#test/unit/laws/model/merge.fixtures.ts"

/** A merged family axis holds exactly when every containment merged into it holds every state of a two-member family with two copies on one axis over three values. */
export const aMergedFamilyAxisHoldsExactlyWhenEveryContainmentMergedIntoItHoldsEveryStateOfATwoMemberFamilyWithTwoCopiesOnOneAxisOverThreeValues =
	property.exhaust(finite(mergeGen), {
		needs: {},
		situations: Arr.flatMap(["owner", "predecessor", "last"] as const, (axis) =>
			Arr.map(verdicts, (v) => [`axis ${axis}`, v] as const)
		) satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (m) =>
			Effect.sync(() => {
				const model = models[m.axis]
				const each = [copyHolds(m, 0), copyHolds(m, 1)]
				const verdict: Verdict = Arr.every(each, (h) => h)
					? "the axis holds"
					: Arr.every(each, (h) => !h)
						? "both copies break"
						: "one copy breaks"
				c.pair(`axis ${m.axis}`, verdict)
				assert.equal(
					!breaks(model, axisKey(model, m.axis), stateOf(model, m)),
					Arr.every(each, (h) => h),
					`${m.axis}: the merged axis holds exactly when both copies do`
				)
			}),
		oracle: {
			kind: "universal",
			name: "metamorphic: the merged axis against each containment's own meaning"
		},
		box: "a two-member family with two copies on the owner, predecessor or last axis, every carried column over 0 to 2",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\tpairs.map((p) => p.from)\n\t\t)\n\t\tconst targetColumns = extendNonEmpty(\n\t\t\ttarget.base,\n\t\t\tpairs.map((p) => p.to)",
				replacement:
					"\t\t\tpairs.slice(0, 1).map((p) => p.from)\n\t\t)\n\t\tconst targetColumns = extendNonEmpty(\n\t\t\ttarget.base,\n\t\t\tpairs.slice(0, 1).map((p) => p.to)",
				why: "An axis's foreign key carries only the first copy riding it (laws/model/plan.ts axis)."
			}
		]
	})
