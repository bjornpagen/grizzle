/**
 * A probed law over a derived relation of closed relations of one unit, no aggregate among them, read at a binding that
 * leaves the unit free, is judged by keyed probe chains from that binding, O(k log n) for the k facts at it, with no
 * storage: the probe reads the definition at the binding (analysis/theory/query.ts liveArms), each step of its chain a
 * lookup of the index its binding requests (physical/index requests, a missed index an ICE), never the units beside it.
 * The consumers' 19 such laws (metis 4, qti-pie 15, none in edullm or den, at the hub heads of 2026-11-26) are of four
 * shapes, each a schema of unit-free.fixtures.ts modelled on one: metis's PartByBase(number, generation), a projection
 * dropping the learner; its AwardDemanded(number), a three-table join of the learner's unit read by the assignment's
 * number; its Submitted(number), the learner in the heading and unbound by the law; and pantry's value containments,
 * a package's nodes joined to their attributes read by the attribute's base type into a closed roster of them.
 *
 * Each case stores its shape's unit 1 beside 2,048 other units of one row of each relation, committed, and measures the judge's work at a write that probes the law at the unit-free
 * binding: each statement the judge runs over the written deltas, explained with ANALYZE in a transaction rolled back
 * (test/support/judge.ts judgeRun), each under its routine's advice (test/support/advice.ts routineAdviceHeld); then
 * stores more units beside them, committed, and measures again.
 *
 * Oracle: a bound and invariance: each statement does the same work beside the 2,048 units and beside the more
 * (judge.ts scannedWork), the rows counted over every loop, never a clock.
 *
 * The box, exhausted: each shape, beside 600 or 900 units more.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runUnitFree,
	type UnitFreeFeature,
	unitFreeGen,
	unitFreeTemplates
} from "#test/pg/laws/unit-free.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A probed law over a non-aggregate derived relation read at a binding that leaves its unit free reads the facts at
 * that binding alone, however many units stand beside them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aProbedLawOverADerivedRelationReadAtABindingThatLeavesItsUnitFreeReadsTheFactsAtThatBindingAloneHoweverManyUnitsStandBeside =
	property.exhaust(finite(unitFreeGen), {
		needs: Substrate.oneOf(unitFreeTemplates, Substrate.fresh),
		situations: [
			"PartByBase measured",
			"AwardDemanded measured",
			"Submitted measured",
			"NodeBase measured"
		] satisfies ReadonlyArray<Reached<UnitFreeFeature>>,
		check: (shapes, c) => (d) =>
			Effect.gen(function* () {
				const shape = yield* shapes[d.shape]
				const session = yield* shape.substrate.session({ ...ownerSession(), label: "unit free" })
				yield* runUnitFree(shape.value, session, d, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "the plans PostgreSQL ran each judged statement by, explained with ANALYZE under its routine's advice: the same rows read beside 2,048 units and beside 600 or 900 more"
		},
		box: "PartByBase(number, generation), AwardDemanded(number) over three relations, Submitted(number) with the learner in its heading, and NodeBase's base type into a closed roster, each beside 2,048 units and then 600 or 900 more",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\t\tif (target === undefined || target.kind === "closed") {\n',
				replacement: '\t\tif (target === undefined || target.kind !== "relation") {\n',
				why: "A stored derived relation's table asks no index of the seeks the judge prints (physical/ddl/rules.ts programRequests): Submitted's table, keyed (child, number, at), has none led by number, so the judge's probe of a report's number is a missed index, an internal compiler error at the installation, where it scanned the table whole."
			}
		]
	})
