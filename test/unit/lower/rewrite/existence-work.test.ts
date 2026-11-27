/**
 * The existence pass (lower/optimize/existence/index.ts shapedExistence) reads each occurrence of a region once to
 * learn the variables it binds without reading them (`unreadBindings`), and counts each variable's such binders once
 * for the region, so an occurrence asks a count whether another binds its variable, where every occurrence gathered
 * every other occurrence's bindings again; and it walks for its columns only an expression that reads the region
 * (`readsNode`, an expression's dependencies), where it walked the closure of every expression of every node below
 * every occurrence. On qti's write compile at hub f1bf91a2f (edullm qti-database, its readback lowering) the two took
 * 74 s and 72 s of 661 s. The work is counted, never timed (test/support/kernel/calls.ts): the calls of unreadBindings
 * and of regionColumns, which walks expressions for the region's columns.
 *
 * Oracle: linearity and a bound, read off the region: every occurrence is alike, so each costs the pass what the third
 * added to the second; and its sources read nothing of the region, so the columns the pass reads do not grow with their
 * depth.
 *
 * Features: a region of one occurrence and of eight; sources one node deep and eight deep.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { Posting, Q } from "#test/unit/lower/conservative/fixtures.ts"
import { ledgerCatalog, passContext, queryOf, runPasses } from "#test/unit/lower/rewrite/support.ts"

type Situation =
	| "a region of one occurrence"
	| "a region of eight occurrences"
	| "sources one node deep"
	| "sources eight nodes deep"

/** The widths and depths of the box. */
const sizes = [1, 2, 3, 4, 5, 6, 7, 8] as const

interface Shape {
	readonly width: (typeof sizes)[number]
	readonly depth: (typeof sizes)[number]
}

/**
 * A region of `width` occurrences of Posting, each its account bound to one shared variable and its id to one of its
 * own, so none is an existence test and the pass reads the region as it stands, and its source a chain of `depth`
 * nodes, projections of a scan's columns over the scan, none reading the region; its shared variable delivered.
 */
const regionOf = ({ width, depth }: Shape) => {
	const q = new Q()
	const source = (): RelNode => {
		let node = q.base(Posting, conservativeMeta)
		for (let at = 1; at < depth; at++) {
			node = q.project(
				node,
				[
					["id", "id"],
					["account", "account"],
					["amount", "amount"]
				],
				conservativeMeta
			)
		}
		return node
	}
	const region = q.region(
		Array.from({ length: width }, (_, at) => ({
			source: source(),
			bind: { account: "a", id: `i${at}` },
			constants: {}
		}))
	)
	return queryOf(q.build(q.project(region, [["a", "a"]], conservativeMeta)).dag, [])
}

/** The calls of unreadBindings and of regionColumns the existence pass makes over `shape`'s region. */
const passWork = (shape: Shape) =>
	Effect.map(
		callCounts(
			Effect.sync(() =>
				succeeded(
					runPasses(
						regionOf(shape),
						[existencePass],
						passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
					)
				)
			),
			{
				occurrences: {
					file: "packages/engine/src/lower/optimize/existence/index.ts",
					name: "unreadBindings"
				},
				columns: {
					file: "packages/engine/src/lower/optimize/existence/index.ts",
					name: "regionColumns"
				}
			}
		),
		([, counts]) => counts
	)

/** The existence pass reads each occurrence's bindings a fixed number of times, however wide the region, and walks no
 * expression that reads nothing of it, however deep its sources. */
export const theExistencePassReadsEachOccurrenceOnceAndWalksOnlyTheExpressionsThatReadTheRegion =
	property.exhaust(
		finite((s) => ({ width: s.draw(element(sizes)), depth: s.draw(element(sizes)) })),
		{
			needs: {},
			situations: [
				"a region of one occurrence",
				"a region of eight occurrences",
				"sources one node deep",
				"sources eight nodes deep"
			] satisfies ReadonlyArray<Reached<Situation>>,
			check: (_, c: Case<Situation>) => (shape) =>
				Effect.gen(function* () {
					const at = (width: Shape["width"]) => passWork({ width, depth: shape.depth })
					const two = yield* at(2)
					const three = yield* at(3)
					const done = yield* passWork(shape)
					assert.ok(two.occurrences > 0, "a region of two reads its occurrences' bindings")
					if (shape.width >= 2) {
						assert.equal(
							done.occurrences,
							two.occurrences + (shape.width - 2) * (three.occurrences - two.occurrences),
							`a region of ${shape.width} reads its occurrences' bindings as two occurrences and ${shape.width - 2} more of what the third added do`
						)
					}
					const shallow = yield* passWork({ width: shape.width, depth: 1 })
					assert.equal(
						done.columns,
						shallow.columns,
						`the pass reads as many columns over sources ${shape.depth} deep as over sources one deep`
					)
					if (shape.width === 1) {
						c.note("a region of one occurrence")
					}
					if (shape.width === 8) {
						c.note("a region of eight occurrences")
					}
					if (shape.depth === 1) {
						c.note("sources one node deep")
					}
					if (shape.depth === 8) {
						c.note("sources eight nodes deep")
					}
				}),
			oracle: {
				kind: "universal",
				name: "linearity and a bound: the calls of unreadBindings over w occurrences are two occurrences' and w − 2 times what the third added; the calls of regionColumns over sources d deep are those over sources one deep"
			},
			box: "every region of one to eight occurrences of Posting sharing one variable, each binding one of its own, over sources one to eight nodes deep",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/existence/index.ts",
					original:
						"\tconst binds = region.occurrences.map((x) => unreadBindings(cell, region, x, classOf))\n",
					replacement:
						"\tconst binds = region.occurrences.map((x) => (region.occurrences.forEach((y) => unreadBindings(cell, region, y, classOf)), unreadBindings(cell, region, x, classOf)))\n",
					why: "Each occurrence gathers every occurrence's bindings again, as each gathered every other's at f1bf91a2f: the reads grow with the square of the width, and the property fails."
				},
				{
					file: "packages/engine/src/lower/optimize/existence/index.ts",
					original:
						"\t\tconst reading = exprsOf(c.current).filter((e) => readsNode(e, region.id))\n",
					replacement: "\t\tconst reading = exprsOf(c.current)\n",
					why: "Every expression of every node below every occurrence is walked for its columns, as at f1bf91a2f: the walks grow with the sources' depth, and the property fails."
				}
			]
		}
	)
