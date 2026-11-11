/**
 * The static seen-state estimate (check/recursion/termination.ts): the product over state columns of the number of
 * values each can take. Planted over a grid walk the generated recursions (unit/recursion/certificates, one counter, a
 * tag and a mark) never build: two independent counters bounded by drawn bounds, a column computed from both, a
 * column of a drawn type copied from data, and a tag column of one literal or two. The rule restated: a bounded counter
 * counts every integer from its seed to its bound; a computed column the product of the columns it reads beside its
 * literals; data, of any type, counts once; a column of literals counts them. A set state column, which no hash
 * operator class deduplicates, is refused at every roster size, its cause naming the recursion and the column.
 *
 * Oracle: the estimate's rule restated as a formula, and the hashing rule (a specification). Features: each copied
 * column's type, a computed column, two tags, the widest grid; each roster size.
 *
 * Plants, each failing its search: a counting recursion's estimate one more than its states (refusals-estimate); a set
 * state column counted as hashable (termination-bits-hashable).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { uuid } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { type HeadTermDesc, textDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
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

const integer: FieldDesc = { kind: "pg", type: "integer" }
const s = (column: string) => varRef(`self.${column}`)
const lit = (n: number) => typedLit(n, integer)

/** A Vertex column copied as data into the state, and its declared type. */
const copied: Arr.NonEmptyReadonlyArray<readonly [string, FieldDesc]> = [
	["active", { kind: "pg", type: "boolean" }],
	["level", { kind: "closedId", roster: "Level" }],
	["rank", { kind: "pg", type: "smallint" }],
	["label", textDesc("^v[0-9]+$", "u")]
]

/**
 * A graph with a roster of `handles`, over which a recursion's state may hold a set. A set column never reaches the
 * estimate: PostgreSQL has no hash operator class for bit strings, and a recursive UNION deduplicates only by hashing,
 * so admission refuses a set state column at the row (check/recursion/state.ts requireHashing) before termination
 * reads it. The estimate's cap of a set at 2ⁿ (termination.ts domainSize) is unreachable from a recursion, whatever
 * the roster's n.
 */
const setsOver = ([first, ...rest]: Arr.NonEmptyReadonlyArray<string>) =>
	schema(
		"Sets",
		{
			Flag: closed("Flag", [first, ...rest]),
			Node: relation("Node", { id: uuid }, ["id"]),
			Link: relation("Link", { from: uuid, to: uuid }, ["from", "to"])
		},
		[]
	)

type EstimateFeature = `copies ${string}` | "a computed column" | "two tags" | "the widest grid"

describe("the seen-state estimate", () => {
	it.effect(
		"multiplies independent counters, a computed column by the columns it reads, data once and literals each",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "two counters each bounded below one to three, a computed column or a literal, one tag or two, and each Vertex column copied as data",
						oracle: {
							kind: "specification",
							name: "termination.ts: counters multiply, a computed column by the columns it reads beside its literal, data once, literals each"
						},
						suite: "unit/recursion/estimate",
						generator: (source) =>
							[
								source.draw((source) => [source.draw(int(1, 3)), source.draw(int(1, 3))] as const),
								source.draw((source) => [source.draw(boolean), source.draw(boolean)] as const),
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
						caseHang
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
								: lit(0)
							const q = succeeded(
								checkAuthored(
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
															x: lit(0),
															y: lit(0),
															sum: lit(0),
															d: ref("Vertex", column),
															tag: lit(1)
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
														where: [lt(s("x"), lit(bx)), lt(s("y"), lit(by))],
														head: {
															node: ref("Edge", "to"),
															x: compute("add", s("x"), lit(1)),
															y: compute("add", s("y"), lit(1)),
															sum,
															d: s("d"),
															tag: twoTags ? lit(2) : s("tag")
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

	it.effect(
		"refuses a set state column, which no hash operator class deduplicates, at every roster size",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "a set state column over a roster of one, two or three handles",
						oracle: {
							kind: "specification",
							name: "state.ts requireHashing: a set state column is unhashable"
						},
						suite: "unit/recursion/estimate-sets",
						generator: int(1, 3),
						literal: Formatter.format,
						/** The space is a roster of one, two or three handles. */
						limit: 3,
						coverage: requiredInSpace<`${number} handles`>(["1 handles", "2 handles", "3 handles"]),
						caseHang
					},
					(n, c) =>
						Effect.sync(() => {
							c.note(`${n} handles`)
							const handles = nonEmpty(
								upTo(n, (i) => `h${i + 1}`),
								"a roster holds one handle at least"
							)
							const set: FieldDesc = { kind: "bits", roster: "Flag" }
							const of = (members: ReadonlyArray<string>) => typedLit({ handles: members }, set)
							const r = checkAuthored(
								checking(setsOver(handles)),
								{
									stage: {
										kind: "recursive",
										recursive: {
											name: "Marks",
											row: { node: { kind: "uuid" }, m: set },
											base: [
												rule({
													vars: vars("Node", "id"),
													matches: [match(relationSource("Node"), { id: ref("Node", "id") })],
													where: [eq(ref("Node", "id"), param("start", { kind: "uuid" }))],
													head: { node: ref("Node", "id"), m: of([]) },
													interiors: [],
													attach: []
												})
											],
											rec: [
												rule({
													vars: [
														...Arr.map(["node", "m"], (v) => plainVar(`self.${v}`)),
														...vars("Link", "to")
													],
													matches: [
														match({ kind: "self" }, { node: s("node"), m: s("m") }),
														match(relationSource("Link"), {
															from: s("node"),
															to: ref("Link", "to")
														})
													],
													where: [],
													head: { node: ref("Link", "to"), m: of(handles) },
													interiors: [],
													attach: []
												})
											]
										}
									}
								},
								checkOptions("query")
							)
							assert.ok(!r.ok, "a set state column is refused")
							const reason = r.error.reason
							if (reason._tag !== "RecursionRefused") {
								return assert.fail(`refused as ${reason._tag}, not by recursion admission`)
							}
							const cause = reason.cause
							assert.ok(cause.kind === "unhashableState", `refused for ${cause.kind}`)
							const { recursion, column } = cause
							assert.deepEqual({ recursion, column }, { recursion: "Marks", column: "m" })
						})
				)
			)
	)
})
