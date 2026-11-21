/** What region-bindings.test.ts reads: its space, the regions of chained occurrences, and the work their extraction does. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Effect } from "effect"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { extractAccess } from "#compiler/physical/access/extract.ts"
import { Ir } from "#test/support/fixtures/ir/build.ts"
import { workModel } from "#test/support/fixtures/ir/work.ts"
import { callCounts } from "#test/support/kernel/calls.ts"

/** The widths of the box, one to sixteen occurrences. */
const widths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const

/**
 * One case: a region of `width` occurrences of Task chained by their columns, the i-th binding its `id` to the variable
 * x‹i› and its `account` to x‹i+1›, so each variable but the ends is a class of two bindings at two occurrences, a join
 * (physical/access/extract.ts regionFacts `relate`); or of Task alone each binding `account` to one shared variable,
 * one class of every binding.
 */
export interface Region {
	readonly shape: "chained" | "shared"
	readonly width: (typeof widths)[number]
}

export const regionGen: Gen<Region> = (s) => ({
	shape: s.draw(element<Region["shape"]>(["chained", "shared"])),
	width: s.draw(element(widths))
})

export type Reached =
	| "a chained region"
	| "a region of one shared class"
	| "a region of one occurrence"
	| "a region of sixteen occurrences"

/** Case `r`'s region `width` wide, built afresh over the Work schema. */
const regionAt = (r: Region, width: number) => {
	const q = new Ir(workModel())
	const occurrences = Array.from({ length: width }, (_, at) => ({
		source: q.base("Task"),
		bind:
			r.shape === "chained"
				? { id: `x${at}`, account: `x${at + 1}` }
				: { id: `t${at}`, account: "account" },
		constants: {}
	}))
	return q.build(q.region(occurrences, conservativeMeta))
}

/**
 * The calls of classOfVar extracting case `r`'s region `width` wide: each binding's variable class read once to index
 * the region's bindings, however many classes the extraction asks the bindings of, counted, never timed.
 */
const bindingsWork = (r: Region, width: number): Effect.Effect<number> =>
	Effect.map(
		callCounts(
			Effect.sync(() => extractAccess(regionAt(r, width).dag.roots, { pageable: [] })),
			{ classes: { file: "packages/engine/src/physical/access/extract.ts", name: "classOfVar" } }
		),
		([, counts]) => counts.classes
	)

/**
 * Judges case `r`: extracting its region `width` wide reads variable classes as often as its region of two does and,
 * for each occurrence more, as often as the third added to the second; where the bindings of a class were found by
 * reading the class of every binding of the region, once for each class asked and once more for each of its bindings
 * a join paired, an occurrence more added a pass over every binding, and the reads grew with the square of the width.
 */
export const judgedRegion = (r: Region, note: (reached: Reached) => void): Effect.Effect<void> =>
	Effect.gen(function* () {
		note(r.shape === "chained" ? "a chained region" : "a region of one shared class")
		if (r.width === 1) {
			note("a region of one occurrence")
		}
		if (r.width === 16) {
			note("a region of sixteen occurrences")
		}
		const two = yield* bindingsWork(r, 2)
		const three = yield* bindingsWork(r, 3)
		assert.ok(three > two, "an occurrence more reads more")
		const work = yield* bindingsWork(r, r.width)
		assert.equal(
			work,
			two + (r.width - 2) * (three - two),
			`extracting the ${r.shape} region of ${r.width} reads classes as two occurrences and ${r.width - 2} occurrences more of what the third added do`
		)
	})
