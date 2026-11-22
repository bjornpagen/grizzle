/**
 * A node over its one input alone whose heading carries every column of its input's under the same name extends the
 * input's dependency table (analysis/physical/rules.ts extendSame, fds.ts DependencyDraft extend): the input's
 * dependencies are the node's own by reference, where the identity embedding copied each one, so a chain of filters over
 * a scan holds the scan's dependencies once. On edullm's qti and pantry drafts the identity embeddings carried 31% of
 * the dependencies the analysis embedded; GENMEM's snapshot of qti's write compile entering certification held 2.85M
 * dependencies, 554 MB.
 *
 * Oracle: identity, read off the chain: every dependency the scan's table holds is, the very object, a dependency of
 * the table atop a chain of filters over it, whatever its depth. That the properties are the copying path's is the
 * argument of DependencyDraft extend, and the analysis properties of analysis/physical (soundness, dependencies) hold
 * every claim to the delivered rows.
 *
 * Features: a chain one filter deep and eight deep.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { analyzePhysical, unplaced } from "#compiler/analysis/physical/analyze.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { asc, Ir } from "#test/support/fixtures/ir/build.ts"
import { workModel } from "#test/support/fixtures/ir/work.ts"

type Situation = "a chain one filter deep" | "a chain eight filters deep"

/** The depths of the box. */
const depths = [1, 2, 3, 4, 5, 6, 7, 8] as const

/** A chain of `depth` filters over a scan of Account under a take of one row, its scan and its top. */
const chainOf = (depth: number) => {
	const q = new Ir(workModel())
	const scan = q.base("Account")
	let top: RelNode = q.take(scan, asc("id"), { kind: "literal", k: 1n }, conservativeMeta)
	for (let at = 0; at < depth; at++) {
		top = q.filter(top, q.eq(q.col(top, "name"), q.col(top, "name")))
	}
	return { built: q.build(top), scan, top }
}

/** A chain of filters over a scan shares the scan's dependencies by reference, however deep. */
export const aChainOfFiltersOverAScanSharesTheScansDependenciesByReferenceHoweverDeep =
	property.exhaust(
		finite((s) => s.draw(element(depths))),
		{
			needs: {},
			situations: ["a chain one filter deep", "a chain eight filters deep"] satisfies ReadonlyArray<
				Reached<Situation>
			>,
			check: (_, c: Case<Situation>) => (depth) =>
				Effect.sync(() => {
					const { built, scan, top } = chainOf(depth)
					const analysis = analyzePhysical(built.dag, {
						context: "snapshot",
						catalog: workModel().fixture.catalog,
						realization: unplaced,
						roots: "result"
					})
					const below = analysis.of(scan).props.dependencies.implications
					const atop = new Set(analysis.of(top).props.dependencies.implications)
					assert.ok(below.length > 0, "the scan's table holds dependencies")
					assert.ok(
						Arr.every(below, (i) => atop.has(i)),
						`every dependency of the scan's table is one of the table atop ${depth} filters, the very object`
					)
					if (depth === 1) {
						c.note("a chain one filter deep")
					}
					if (depth === 8) {
						c.note("a chain eight filters deep")
					}
				}),
			oracle: {
				kind: "universal",
				name: "identity: every dependency of the scan's table is the very object atop a chain of filters over it"
			},
			box: "every chain of one to eight filters over a take of one Account row",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/physical/rules.ts",
					original: "\tif (!input.columns.every((c) => fds.has(c))) {\n",
					replacement: "\tif (true) {\n",
					why: "Every node over its one input embeds the input's table as inheritSame does, copying each dependency, as at 6b588e94d: the table atop the chain holds copies, and the property fails."
				}
			]
		}
	)
