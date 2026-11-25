/** What copy-shapes.test.ts reads: its space, its schemas, and the calls of the copy plan's modules in a judge's compile. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, String as Str } from "effect"
import type { QueryDesc as QueryOf, SchemaDesc } from "#compiler/ir/desc.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	check,
	decodedQuery,
	decodedSchema,
	eq,
	f,
	field,
	relation
} from "#test/support/fixtures/ir/desc.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"
import { owning } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/** Half the least of the three depths a case compiles: 2·half, 4·half and 6·half. */
export const halfGen: Gen<number> = int(1, 2)

export type Reached = "depths 2, 4 and 6" | "depths 4, 8 and 12"

/** The modules whose calls are the copy plan's work: the plan itself and the forms it writes. */
export const counted = {
	copies: "packages/engine/src/lower/shapes/share/copies.ts",
	digests: "packages/engine/src/ir/dag-digest.ts"
} as const

/** A rule's arm: each row of `relation`, beside a row of the query `beside` at its key and value where one is given. */
const factArm = (relation: string, beside: QueryOf | undefined) => ({
	vars: [
		{ id: "child", origin: { relation, field: "child" } },
		{ id: "x", origin: { relation, field: "x" } }
	],
	matches: [
		{
			source: { kind: "relation" as const, name: relation },
			bindings: {
				child: { kind: "var" as const, var: "child" },
				x: { kind: "var" as const, var: "x" }
			}
		},
		...(beside === undefined
			? []
			: [
					{
						source: { kind: "query" as const, query: beside, bind: {} },
						bindings: {
							child: { kind: "var" as const, var: "child" },
							y: { kind: "var" as const, var: "x" }
						}
					}
				])
	],
	where: [],
	head: { child: { kind: "var" as const, var: "child" }, y: { kind: "var" as const, var: "x" } },
	interiors: [],
	attach: []
})

/**
 * The union of depth n: each fact of F<n> beside a row of the union of depth n - 1 at the fact's values, which the
 * checker imports at those values, a sub-query correlated to the arm's region, and each fact of G<n> alone, which no
 * import fuses into its reader's region; so the union of depth k, read at a budget's values, is k unions nested, each
 * correlated, no two of one shape.
 */
const unionOf = (n: number): QueryOf =>
	decodedQuery({
		kind: "rules",
		arms: [factArm(`F${n}`, n === 0 ? undefined : unionOf(n - 1)), factArm(`G${n}`, undefined)]
	})

/**
 * The schema of depth `depth`: facts F<n> and G<n> and the budgets in the base, and above it each budget beside the
 * union of depth `depth` at its own values, which a check holds.
 */
const nestedUnions = (depth: number): SchemaDesc => {
	const i = f.integer
	const base = decodedSchema({
		name: `copy_shapes_${depth}`,
		relations: [
			...upTo(depth + 1, (n) => relation(`F${n}`, { child: i, x: i }, ["child"])),
			...upTo(depth + 1, (n) => relation(`G${n}`, { child: i, x: i }, ["child"])),
			relation("Budget", { child: i, remaining: i }, ["child"])
		],
		statements: [],
		bases: []
	})
	return decodedSchema({
		name: `copy_shapes_${depth}_left`,
		relations: [
			{
				kind: "derived",
				name: "Left",
				level: 1,
				query: decodedQuery({
					kind: "rules",
					arms: [
						{
							vars: [
								{ id: "child", origin: { relation: "Budget", field: "child" } },
								{ id: "remaining", origin: { relation: "Budget", field: "remaining" } }
							],
							matches: [
								{
									source: { kind: "relation", name: "Budget" },
									bindings: {
										child: { kind: "var", var: "child" },
										remaining: { kind: "var", var: "remaining" }
									}
								},
								{
									source: { kind: "query", query: unionOf(depth), bind: {} },
									bindings: {
										child: { kind: "var", var: "child" },
										y: { kind: "var", var: "remaining" }
									}
								}
							],
							where: [],
							head: {
								child: { kind: "var", var: "child" },
								remaining: { kind: "var", var: "remaining" }
							},
							interiors: [],
							attach: []
						}
					]
				})
			}
		],
		statements: [check("Left_kept", "Left", eq(field("remaining"), field("child")))],
		bases: [base]
	})
}

/** The calls the installation's compile of the schema of depth `depth` makes in each counted module. */
export const callsAt = (depth: number) =>
	Effect.gen(function* () {
		const owned = owning(nestedUnions(depth))
		const [, counts] = yield* everyCallCount(
			Effect.sync(() =>
				succeeded(
					compileInstallation(owned, installOptions(owned)),
					`the schema of depth ${depth} compiles`
				)
			),
			(file) => file === counted.copies || file === counted.digests
		)
		return Arr.reduce(
			Arr.filter([...counts], ([key]) =>
				Arr.some([counted.copies, counted.digests], (file) => Str.startsWith(`${file}:`)(key))
			),
			0,
			(n, [, k]) => n + k
		)
	})
