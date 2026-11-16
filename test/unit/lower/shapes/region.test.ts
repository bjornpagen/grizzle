/**
 * The optimized MatchRegion past PostgreSQL's collapse limit (shapes/region): a region of more than eight
 * occurrences is an explicit JOIN chain, so PostgreSQL plans it in subproblems of at most join_collapse_limit relations
 * rather than one flat FROM list at geqo_threshold.
 *
 * Over generated paths of nine to fourteen edges, one of them restricted by a parameter, written in any order: the
 * chain joins every occurrence with no CROSS JOIN, each link's ON reads both of its sides, and the chain starts at the
 * restricted occurrence, whose restriction stays in WHERE. A chain that dropped a link's condition would plan a cross
 * product; one that started elsewhere would put the selective occurrence in a late subproblem.
 *
 * Oracle: the region shape's statement (shapes/region/index.ts) as a checker over the statement's AST (a
 * specification). Features: the restricted occurrence written first and later, the longest path. Kept: the restricted
 * occurrence written first.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { featureCount, shapeOf } from "#test/support/kernel/shape.ts"
import {
	aliasesOf,
	aliasOf,
	chainOf,
	conjuncts,
	maxEdges,
	pathDesc,
	pathOf,
	pathSketchGen,
	Plan,
	type RegionFeature,
	tablesRead
} from "#test/unit/lower/shapes/region.fixtures.ts"

/**
 * A region past the collapse limit is an explicit JOIN chain joins every occurrence on a condition that reads both
 * sides, starting at the restricted one.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/lower/shapes/region.test.ts:209 at 8cad5bce, its runs and its coverage's cases).
 */
export const aRegionPastTheCollapseLimitIsAnExplicitJOINChainJoinsEveryOccurrenceOnAConditionThatReadsBothSidesStartingAtTheRestrictedOne =
	property.explore(pathSketchGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"restricted first written",
			"restricted written later",
			"longest path"
		] satisfies ReadonlyArray<Reached<RegionFeature>>,
		check: (_, c: Case<RegionFeature>) => (sketch) =>
			Effect.gen(function* () {
				const path = pathOf(sketch)
				return yield* Effect.sync(() => {
					const compiled = succeeded(
						compileTemplate(pathDesc(path), Plan, {
							...testCompile,
							installation: identity.schema(parsedSchemaName("plan"))
						})
					)
					const [statement] = programAsts(compiled.programs.optimized)
					assert.equal(featureCount(shapeOf(statement), "cross join"), 0)
					assert.equal(featureCount(shapeOf(statement), "join"), path.edges - 1)
					const found = Option.getOrThrowWith(
						chainOf(statement),
						() => new Error("a core reads the chain")
					)
					transformStatement(statement, {
						...identityHooks,
						joins: (chain) => {
							const left = new Set([aliasOf(chain.first)])
							for (const step of chain.steps) {
								const right = aliasOf(step.source)
								if (step.kind === "on") {
									const read = tablesRead(step.on)
									assert.ok(
										Arr.some([...read], (a) => left.has(a)) && read.has(right),
										"an ON reads both sides"
									)
								}
								left.add(right)
							}
							return chain
						}
					})
					const [start] = aliasesOf(found.chain)
					assert.ok(start !== undefined, "the chain has a first occurrence")
					const restriction = Arr.some(
						conjuncts(found.core.where),
						(e) =>
							e.kind === "binary" &&
							e.op === "=" &&
							((e.right.kind === "param" && tablesRead(e.left).has(start)) ||
								(e.left.kind === "param" && tablesRead(e.right).has(start)))
					)
					assert.ok(
						restriction,
						`the chain starts at ${start}, which the parameter restricts in WHERE`
					)
					c.note(
						path.order[0] === path.restricted
							? "restricted first written"
							: "restricted written later"
					)
					if (path.edges === maxEdges) {
						c.note("longest path")
					}
				})
			}),
		oracle: {
			kind: "specification",
			name: "one JOIN chain over every occurrence, each ON reading both sides, starting at the restricted one"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/shapes/region.test.ts#aRegionPastTheCollapseLimitIsAnExplicitJOINChainJoinsEveryOccurrenceOnAConditionThatReadsBothSidesStartingAtTheRestrictedOne:-:0.4.1.1.1.1.0.1.1.1.1.1.1.1.1.1"
				),
				reason: "the restricted occurrence written first",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original:
					"\t\tmore.reduce((acc, p) => (tier(p, chained) < tier(acc, chained) ? p : acc), candidate)",
				replacement: "\t\tmore.reduce((acc) => acc, candidate)",
				why: "The chain takes its occurrences in written order, never preferring the selective one, so it starts wherever the region was written; the search fails."
			}
		]
	})
