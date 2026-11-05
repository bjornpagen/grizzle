import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { codePoint, constant, int, oneOf, string, uniqueArray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { contract, pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { pointIn } from "#compiler/query/build/terms.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import {
	assert,
	containsText,
	defined,
	refusalLoc,
	refused,
	succeeded
} from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { decodedQuery } from "#test/support/fixtures/ir/desc.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"

const Instant = contract("Instant", pg.bigint)
const Slot = relation(
	"Slot",
	{ id: pg.integer, room: uuid, during: span(pg.integer), at: pg.integer },
	["id"]
)
const Visit = relation("Visit", { id: uuid, stay: span(Instant), at: Instant }, ["id"])
const Spans = schema("Spans", { Slot, Visit }, [])

const compiled = (q: unknown): QueryTemplate =>
	succeeded(
		compileTemplate(q, undefined, {
			...testCompile,
			installation: identity.schema(parsedSchemaName("spans"))
		}),
		"the span query compiles"
	)

/** The ASTs of every statement of both artifacts. */
const statements = (t: QueryTemplate): ReadonlyArray<SqlStatement> => [
	...Arr.map(flight(t.programs.optimized.roots), (s) => s.ast),
	...Arr.map(flight(t.programs.conservative.roots), (s) => s.ast)
]

const Shift = relation("Shift", { id: pg.integer, slot: span(pg.integer, 15), at: pg.integer }, [
	"id"
])
const Shifts = schema("Shifts", { Shift, Visit }, [])

/** The encoder of a template's only parameter, in both artifacts. */
const encoders = (t: QueryTemplate) =>
	Arr.map([...t.optimized, ...t.conservative], (s) => {
		const slot = s.paramSlots[0]
		if (slot === undefined || s.paramSlots.length !== 1 || slot.kind !== "scalar") {
			throw new Error("one scalar parameter slot")
		}
		return slot.encode
	})

describe("span parameters and windows", () => {
	it.effect(
		"admits a pointIn of two parameters at their declared types, and refuses one whose point misses the window's endpoint",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/spans/point-in-params",
						draw: drawn(
							uniqueArray(
								string(codePoint(0x61, 0x7a), { min: 1, max: 6 }),
								(name) => name,
								{ min: 2, max: 2 },
								10
							)
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 30,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([point, window]) =>
						Effect.sync(() => {
							const pointName = defined(point, "a parameter name")
							const windowName = defined(window, "a parameter name")
							query(Spans).rule((r) => {
								const { id } = v(Slot, "slot")
								return r
									.match(Slot, { id })
									.where(
										pointIn(r.param(pointName, pg.integer), r.param(windowName, span(pg.integer)))
									)
									.find({ id })
							})
							const described = (pointType: "integer" | "bigint"): QueryDesc =>
								decodedQuery({
									kind: "rules",
									arms: [
										{
											vars: [{ id: "i", origin: { relation: "Slot", field: "id" } }],
											matches: [
												{
													source: { kind: "relation", name: "Slot" },
													bindings: { id: { kind: "var", var: "i" } }
												}
											],
											where: [
												{
													kind: "pointIn",
													point: {
														kind: "param",
														name: pointName,
														type: { kind: "pg", type: pointType }
													},
													span: {
														kind: "param",
														name: windowName,
														type: {
															kind: "span",
															endpoint: { kind: "pg", type: "integer" },
															width: undefined
														}
													}
												}
											],
											head: { i: { kind: "var", var: "i" } },
											interiors: [],
											attach: []
										}
									]
								})
							const compiled = (pointType: "integer" | "bigint") =>
								compileTemplate(described(pointType), Spans, {
									...testCompile,
									installation: identity.schema(parsedSchemaName("spans"))
								})
							assert.ok(compiled("integer").ok, "two declared parameters meet in pointIn")
							const failure = refused(compiled("bigint"), "MalformedDescription")
							containsText(formatLoc(refusalLoc(failure)), "pointIn")
						})
				)
			)
	)

	it.effect(
		"binds a window or an equated value of a fixed-width span at its declared width, and refuses another width at bind",
		(ctx) => {
			const window = compiled(
				query(Shifts).rule((r) => {
					const { id, slot } = v(Shift, "shift")
					return r
						.match(Shift, { id, slot })
						.where(r.allen(slot, ALLEN.intersects, r.param("w", Shift.fields.slot)))
						.find({ id })
				})
			)
			const equated = compiled(
				query(Shifts).rule((r) => {
					const { id } = v(Shift, "shift")
					return r.match(Shift, { id, slot: r.param("s", Shift.fields.slot) }).find({ id })
				})
			)
			for (const statement of statements(equated)) {
				assert.ok(has(shapeOf(statement), "predicate = column param"))
			}
			for (const st of Arr.appendAll(
				flight(equated.programs.optimized.roots),
				flight(equated.programs.conservative.roots)
			)) {
				assert.deepEqual(
					Arr.map(st.params, (slot) => (slot.kind === "scalar" ? slot.sqlType : undefined)),
					[types.int4range]
				)
			}
			return searched(
				ctx,
				explore(
					{
						suite: "unit/spans/fixed-width-binding",
						draw: drawn((source) => ({
							start: source.draw(int(-1000, 1000)),
							width: source.draw(oneOf([constant(15), int(1, 60)]))
						})),
						literal: Formatter.format,
						coverage: required<"the column's width" | "another width">(
							["the column's width", "another width"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ start, width }, c) =>
						Effect.sync(() => {
							c.note(width === 15 ? "the column's width" : "another width")
							/** Each statement's encoder of the parameter, of its declared type: the column's fixed-width span. */
							const declared = [...encoders(window), ...encoders(equated)]
							for (const encode of declared) {
								const encoded = encode({ start, end: start + width })
								if (width === 15) {
									assert.deepEqual(encoded, Result.ok(`[${start},${start + width})`))
								} else {
									refused(encoded, "spanWidth")
								}
							}
						})
				)
			)
		}
	)
})
