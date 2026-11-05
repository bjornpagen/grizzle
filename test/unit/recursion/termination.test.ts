import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import type { HeadTermDesc } from "#test/support/fixtures/ir/desc.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	compute,
	eq,
	lt,
	match,
	narrowed,
	param,
	plainVar,
	ref,
	relationSource,
	rule,
	typedLit,
	varRef,
	vars
} from "#test/unit/check/dsl.ts"
import { Graph, theRecursive } from "#test/unit/recursion/fixtures.ts"

/**
 * The static seen-state estimate (check/recursion/termination.ts): the product over state columns of the number of
 * values each can take. Planted over a grid walk the generated recursions (unit/recursion/certificates, one counter, a
 * tag and a mark) never build: two independent counters bounded by drawn bounds, a column computed from both, a
 * column of a drawn type copied from data, and a tag column of one literal or two. The rule restated: a bounded counter
 * counts every integer from its seed to its bound; a computed column the product of the columns it reads beside its
 * literals; data, of any type, counts once; a column of literals counts them.
 */

const integer: FieldDesc = { kind: "pg", type: "integer" }
const s = (column: string) => varRef(`self.${column}`)
const int = (n: number) => typedLit(n, integer)

/** A Vertex column copied as data into the state, and its declared type. */
const copied: Arr.NonEmptyReadonlyArray<readonly [string, FieldDesc]> = [
	["active", { kind: "pg", type: "boolean" }],
	["level", { kind: "closedId", roster: "Level" }],
	["rank", { kind: "pg", type: "smallint" }],
	["label", { kind: "text", source: "^v[0-9]+$", flags: "u" }]
]

type EstimateFeature = `copies ${string}` | "a computed column" | "two tags" | "the widest grid"

describe("the seen-state estimate", () => {
	it.effect(
		"multiplies independent counters, a computed column by the columns it reads, data once and literals each",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/recursion/estimate",
						generator: (source) =>
							[
								source.draw(
									(source) =>
										[source.draw(element([1, 2, 3])), source.draw(element([1, 2, 3]))] as const
								),
								source.draw(
									(source) =>
										[
											source.draw(element([false, true])),
											source.draw(element([false, true]))
										] as const
								),
								source.draw(element(copied))
							] as const,
						literal: Formatter.format,
						limit: 200,
						coverage: requiredInSpace<EstimateFeature>([
							...Arr.map(copied, ([column]): EstimateFeature => `copies ${column}`),
							"a computed column",
							"two tags",
							"the widest grid"
						]),
						caseHang: Duration.minutes(2)
					},
					([[bx, by], [summed, twoTags], [column, type]], c) =>
						Effect.sync(() => {
							c.note(`copies ${column}`)
							if (summed) {
								c.note("a computed column")
							}
							if (twoTags) {
								c.note("two tags")
							}
							if (bx === 3 && by === 3) {
								c.note("the widest grid")
							}
							const sum: HeadTermDesc = summed
								? narrowed(compute("add", s("x"), s("y")), "integer")
								: int(0)
							const q = succeeded(
								checkQuery(
									checking(Graph),
									{
										stage: {
											kind: "recursive",
											recursive: {
												name: "Grid",
												row: {
													node: { kind: "uuid" },
													x: integer,
													y: integer,
													sum: integer,
													d: type,
													tag: integer
												},
												base: [
													rule({
														vars: vars("Vertex", "id", column),
														matches: [
															match(relationSource("Vertex"), {
																id: ref("Vertex", "id"),
																[column]: ref("Vertex", column)
															})
														],
														where: [eq(ref("Vertex", "id"), param("start", { kind: "uuid" }))],
														head: {
															node: ref("Vertex", "id"),
															x: int(0),
															y: int(0),
															sum: int(0),
															d: ref("Vertex", column),
															tag: int(1)
														},
														interiors: [],
														attach: []
													})
												],
												rec: [
													rule({
														vars: [
															...Arr.map(["node", "x", "y", "d", "tag"], (v) =>
																plainVar(`self.${v}`)
															),
															...vars("Edge", "to")
														],
														matches: [
															match(
																{ kind: "self" },
																{ node: s("node"), x: s("x"), y: s("y"), d: s("d"), tag: s("tag") }
															),
															match(relationSource("Edge"), {
																from: s("node"),
																to: ref("Edge", "to")
															})
														],
														where: [lt(s("x"), int(bx)), lt(s("y"), int(by))],
														head: {
															node: ref("Edge", "to"),
															x: compute("add", s("x"), int(1)),
															y: compute("add", s("y"), int(1)),
															sum,
															d: s("d"),
															tag: twoTags ? int(2) : s("tag")
														},
														interiors: [],
														attach: []
													})
												]
											}
										}
									},
									checkOptions("query")
								)
							)
							/**
							 * x counts 0..bx and y 0..by; sum, their exact sum narrowed into integer under its guard, its literal beside
							 * x * y when computed from them; d, data, once; tag its literals.
							 */
							const counts = (BigInt(bx) + 1n) * (BigInt(by) + 1n)
							const cert = theRecursive(q).termination
							assert.equal(cert.kind, "boundedState")
							assert.equal(
								cert.stateEstimate,
								counts * (summed ? 1n + counts : 1n) * (twoTags ? 2n : 1n)
							)
						})
				)
			)
	)
})
