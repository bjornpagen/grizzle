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
 * One case: a region of `width` occurrences of Task chained by the columns no key of it holds, each next one joined to
 * the one before it at `account` and at `kind` in turn, the i-th binding its `account` to a‹⌊i/2⌋› and its `kind` to
 * k‹⌊(i+1)/2⌋›, its `id` to a variable of its own, so each variable but the ends is a class of two bindings at two
 * occurrences, a join (physical/access/extract.ts regionFacts `relate`), and no occurrence reaches another by its key:
 * a region no chain reads, which PostgreSQL joins, and whose facts the extraction reads. A chain by the key, the i-th
 * binding its `id` to the variable its predecessor's `account` binds, is read from its root (cte-policy rootChain), its
 * steps' paths asked of the chain alone and no facts read. Or of Task alone each binding `account` to one shared
 * variable, one class of every binding.
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
				? { id: `t${at}`, account: `a${Math.floor(at / 2)}`, kind: `k${Math.floor((at + 1) / 2)}` }
				: { id: `t${at}`, account: "account" },
		constants: {}
	}))
	return q.build(q.region(occurrences, conservativeMeta))
}

/** The work an extraction does that the properties count: variable classes read, and base types of columns read. */
export type Work = "classes" | "carriers"

/**
 * The calls extracting case `r`'s region `width` wide makes, counted, never timed: of classOfVar, each binding's
 * variable class read once to index the region's bindings, however many classes the extraction asks the bindings of;
 * or of baseOf (ir/scalar.ts), each heading column's base type read once to index its heading's carriers, however many
 * columns the region's contexts ask the carrier of.
 */
const extractionWork = (r: Region, width: number, work: Work): Effect.Effect<number> =>
	Effect.map(
		callCounts(
			Effect.sync(() =>
				extractAccess(regionAt(r, width).dag.roots, {
					pageable: [],
					keyOrders: () => [],
					worlds: () => undefined
				})
			),
			{
				classes: { file: "packages/engine/src/physical/access/extract.ts", name: "classOfVar" },
				carriers: { file: "packages/engine/src/ir/scalar.ts", name: "baseOf" }
			}
		),
		([, counts]) => counts[work]
	)

/**
 * Judges case `r` on `work`: extracting its region `width` wide does it as often as its region of two does and, for each
 * occurrence more, as often as the third added to the second. Where the bindings of a class were found by reading the
 * class of every binding of the region, once for each class asked and once more for each of its bindings a join
 * paired, an occurrence more added a pass over every binding; where a column's carrier was found by reading the base
 * type of the column a scan of its heading found, once for every column each context fixes, an occurrence more added a
 * read for each partner of every occurrence of one shared class: either grew with the square of the width.
 */
export const judgedRegion = (
	r: Region,
	work: Work,
	note: (reached: Reached) => void
): Effect.Effect<void> =>
	Effect.gen(function* () {
		note(r.shape === "chained" ? "a chained region" : "a region of one shared class")
		if (r.width === 1) {
			note("a region of one occurrence")
		}
		if (r.width === 16) {
			note("a region of sixteen occurrences")
		}
		const two = yield* extractionWork(r, 2, work)
		const three = yield* extractionWork(r, 3, work)
		assert.ok(
			two > 0 && three >= two,
			`a region of two reads ${work}, and one of three as much or more`
		)
		const done = yield* extractionWork(r, r.width, work)
		assert.equal(
			done,
			two + (r.width - 2) * (three - two),
			`extracting the ${r.shape} region of ${r.width} reads ${work} as two occurrences and ${r.width - 2} occurrences more of what the third added do`
		)
	})
