/**
 * The optimized MatchRegion's join order (shapes/region chainOrder): a region's FROM lists its occurrences in the order
 * its statement is planned in, which the binding pass carries as written and nests so no join problem PostgreSQL plans
 * holds more than eight items (sql/bind.ts), so a region of any width is one flat FROM list, never a JOIN chain past
 * join_collapse_limit, and its order is evidence's: it starts at the occurrence a parameter restricts, and each later
 * occurrence is joined by a condition to one before it.
 *
 * Over generated paths of nine to fourteen edges, one of them restricted by a parameter, written in any order: the FROM
 * lists every occurrence with no CROSS JOIN, starts at the restricted occurrence, whose restriction is in WHERE, and
 * each later occurrence is equated with one before it in WHERE. An order that started elsewhere would drive the
 * statement from an unrestricted edge; one that took an occurrence before any it joins would read a cross product.
 *
 * Oracle: the region shape's statement (shapes/region/index.ts) as a checker over the statement's AST (a
 * specification). Features: the restricted occurrence written first and later, the longest path. Kept: the restricted
 * occurrence written first.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { featureCount, shapeOf } from "#test/support/kernel/shape.ts"
import {
	conjuncts,
	maxEdges,
	pathDesc,
	pathOf,
	pathSketchGen,
	Plan,
	type RegionFeature,
	regionCoreOf,
	tablesRead
} from "#test/unit/lower/shapes/region.fixtures.ts"

/**
 * A region's FROM starts at its restricted occurrence and joins each later one to one before it, whatever its width.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/lower/shapes/region.test.ts:209 at 8cad5bce, its runs and its coverage's cases).
 */
export const aRegionsFromStartsAtTheRestrictedOccurrenceAndJoinsEachLaterOneToOneBeforeIt =
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
					assert.equal(featureCount(shapeOf(statement), "join"), 0)
					const found = Option.getOrThrowWith(
						regionCoreOf(statement, path.edges),
						() => new Error("a core reads every occurrence")
					)
					const where = conjuncts(found.core.where)
					for (const [i, alias] of found.aliases.entries()) {
						const before = new Set(found.aliases.slice(0, i))
						assert.ok(
							i === 0 ||
								Arr.some(where, (e) => {
									const read = tablesRead(e)
									return read.has(alias) && Arr.some([...read], (a) => before.has(a))
								}),
							`${alias} is joined to an occurrence before it`
						)
					}
					const [start] = found.aliases
					assert.ok(start !== undefined, "the FROM has a first occurrence")
					const restriction = Arr.some(
						where,
						(e) =>
							e.kind === "binary" &&
							e.op === "=" &&
							((e.right.kind === "param" && tablesRead(e.left).has(start)) ||
								(e.left.kind === "param" && tablesRead(e.right).has(start)))
					)
					assert.ok(
						restriction,
						`the FROM starts at ${start}, which the parameter restricts in WHERE`
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
			name: "one FROM list over every occurrence, starting at the restricted one, each later one joined to one before it"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/shapes/region.test.ts#aRegionsFromStartsAtTheRestrictedOccurrenceAndJoinsEachLaterOneToOneBeforeIt:-:0.4.1.1.1.1.0.1.1.1.1.1.1.1.1.1"
				),
				reason: "the restricted occurrence written first",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original: "\t\tmore.reduce((acc, p) => (rank(p) < rank(acc) ? p : acc), candidate)",
				replacement: "\t\tmore.reduce((acc) => acc, candidate)",
				why: "The order takes its occurrences in written order, never preferring the selective one, so the FROM starts wherever the region was written; the search fails."
			}
		]
	})
