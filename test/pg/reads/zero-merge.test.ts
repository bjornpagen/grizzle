/**
 * A float's two zeros under every operation that takes one value for several equal ones (check/merge.ts,
 * scalar/aggregate.ts), on PostgreSQL 19 under hash, sort, index and parallel plans: a keyed read delivers each
 * fact's own zero; a projection, a group key, a union of keyed rows, a join variable and a recursion's state deliver
 * +0 for either zero, a lone -0 among them; a min and a max are IEEE 754-2019's, -0 below +0, and a sum and a mean of
 * zeros are -0 exactly when each zero is.
 *
 * Oracle: the specification, the merged zero and IEEE 754-2019's aggregates over the stored facts
 * (zero-merge.fixtures.ts expected).
 *
 * Features: each read under each plan shape.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { Db } from "#adapter/public/db.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	expected,
	type Feature,
	factsOf,
	features,
	Merges,
	mergesInstall,
	mergesTemplate,
	reads,
	type Sketch,
	setText,
	sketchGen
} from "#test/pg/reads/zero-merge.fixtures.ts"
import { planShapeOn } from "#test/support/plan-shapes.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** Zeros as their signs, in order. */
const zerosText = (xs: ReadonlyArray<number>): string =>
	`[${Arr.join(
		Arr.map(xs, (x) => (Object.is(x, -0) ? "-0" : "0")),
		", "
	)}]`

/** A float's two zeros are one value to every merge, which delivers +0 for either, and IEEE 754-2019's to every aggregate, on PostgreSQL 19 under every plan shape: a keyed read delivers each fact's own zero. */
export const aFloatsTwoZerosAreOneValueToEveryMergeWhichDeliversPlus0ForEitherAndIEEE7542019sToEveryAggregateUnderEveryPlanShape =
	property.exhaust(finite(sketchGen), {
		needs: { fixture: Substrate.fresh(mergesTemplate) },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(s: Sketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Merges, {}, mergesInstall, taken)
								yield* planShapeOn(o.installed.as(o.server).role, s.shape)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									yield* db.workload.load.once({ params: {}, facts: { insert: factsOf(s) } })
									const none = { params: {}, facts: {} }
									const keyed = yield* db.workload.keyed.once(none)
									const projected = yield* db.workload.projected.once(none)
									const grouped = yield* db.workload.grouped.once(none)
									const extremes = yield* db.workload.extremes.once(none)
									const totals = yield* db.workload.totals.once(none)
									const united = yield* db.workload.united.once(none)
									const joined = yield* db.workload.joined.once(none)
									const reached = yield* db.workload.reached.once(none)
									const answers = {
										keyed: setText(keyed),
										projected: setText(projected),
										grouped: setText(grouped),
										extremes: setText(extremes),
										totals: setText(totals),
										united: setText(united),
										joined: setText(joined),
										reached: setText(reached)
									}
									for (const read of reads) {
										assert.deepEqual(
											answers[read],
											expected(s, read),
											`${read} under the ${s.shape} plan over F ${zerosText(s.f)} and G ${zerosText(s.g)}`
										)
										c.note(`${read} under the ${s.shape} plan`)
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the merged zero, +0, and IEEE 754-2019's min, max, sum and mean over the stored facts (zero-merge.fixtures.ts expected)"
		},
		box: "F of one or two zeros in each order and G of none or one zero, under each plan shape",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/merge.ts",
				original: "\t\tconst canonical = canonicalOuts(analysis, merge)",
				replacement: "\t\tconst canonical = new Set<string>()",
				why: "No head takes the canonical zero, so a projection of a lone -0 delivers -0, and of both zeros whichever its plan keeps."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\t\t\tthis.#merges.set(node, { ...merge, rule: { kind: "always" } })',
				replacement: "\t\t\tvoid merge",
				why: "A union's keyed arm keeps its fact's zero, so the union delivers -0 for a row it may take for G's +0."
			},
			{
				file: "packages/engine/src/check/merge.ts",
				original: '\t\t(region.joined.length > 0 || (delivered === "key" && !oneFact(c)))',
				replacement: "\t\tfalse",
				why: "A group keyed by a float keeps the zero its plan meets first, so a group of a lone -0 is keyed -0."
			},
			{
				file: "packages/engine/src/check/merge.ts",
				original: "\t\t\t.filter((v) => !equalityIsIdentity(v.type) && (binders.get(v) ?? 0) >= 2)",
				replacement:
					"\t\t\t.filter((v) => !equalityIsIdentity(v.type) && (binders.get(v) ?? 0) >= 2 && false)",
				why: "A join variable bound by F's and G's fields reads one of them, so the join delivers -0 where either side holds it."
			},
			{
				file: "packages/engine/src/check/recursion/index.ts",
				original: "\t\t\t\tbase: cx.canonicalArm(base, baseLoc),",
				replacement: "\t\t\t\tbase,",
				why: "A recursion's base keeps F's -0, which its recursive UNION keeps over the step's +0 of G at the same key."
			},
			{
				file: "packages/engine/src/scalar/aggregate.ts",
				original: "\t\tlowering: float === undefined ? native : signedExtreme(name, float)",
				replacement: "\t\tlowering: native",
				why: "A float's min and max are PostgreSQL's native ones, which keep the last of two equal zeros a scan meets, so min(-0, 0) is 0."
			},
			{
				file: "packages/engine/src/lower/conservative/group/index.ts",
				original: "\t\t: zerosSum(float, arg, arg, zeroOf(float, false), window)",
				replacement: "\t\t: zeroOf(float, false)",
				why: "A float sum or mean of zeros is +0, so the sum of a lone -0 is 0."
			}
		]
	})
