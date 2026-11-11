/**
 * Span parameters and windows, as the builder records them and the compiler lowers them.
 *
 * - pointIn of two parameters: over every pair of a point's type and a window's endpoint (integer, bigint), the
 *   builder and the compile of the same description both admit it exactly where the two are one type, compatibility
 *   being nominal (scalar/compute/types.ts compatible); the compile refuses any other as MalformedDescription at
 *   pointIn's point. Oracle: the specification, nominal compatibility.
 * - Fixed-width spans: a window or an equated value of Shift's slot, a span of integer fixed at width 15, is bound at
 *   its declared type, int4range, in every statement of both artifacts, and its encoder admits exactly the spans of
 *   width 15, written as [start, end), refusing every other width at bind (spanWidth). Oracle: the specification.
 *
 * Features: admitted and refused pairs; the column's width and another width.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): spans-point-in-widened.patch (the compile admitting a point of any
 * integer type) turns the pointIn property red; spans-width-off-by-one.patch (a fixed width admitting one more unit)
 * the binding one.
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { constant, element, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { contract, pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { pointIn } from "#compiler/query/build/terms.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { assert, placeOf, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { decodedQuery } from "#test/support/fixtures/ir/desc.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { caseHang } from "#test/support/limits.ts"
import { sentForms } from "#test/support/oracle/forms.ts"
import { paramText } from "#test/support/wire.ts"

const Instant = contract("Instant", pg.bigint)
const Slot = relation(
	"Slot",
	{ id: pg.integer, room: uuid, during: span(pg.integer), at: pg.integer },
	["id"]
)
const Visit = relation("Visit", { id: uuid, stay: span(Instant), at: Instant }, ["id"])
const Spans = schema("Spans", [Slot, Visit], [])

const compiled = (q: unknown): OracleTemplate =>
	succeeded(
		compileTemplate(q, undefined, {
			...testCompile,
			installation: identity.schema(parsedSchemaName("spans"))
		}),
		"the span query compiles"
	)

/** The ASTs of every statement of both artifacts. */
const statements = (t: OracleTemplate): ReadonlyArray<SqlStatement> => [
	...programAsts(t.programs.optimized),
	...Arr.map(flight(t.programs.conservative.roots), (s) => s.ast)
]

const Shift = relation("Shift", { id: pg.integer, slot: span(pg.integer, 15), at: pg.integer }, [
	"id"
])
const Shifts = schema("Shifts", [Shift, Visit], [])

/** The endpoint types a span parameter is declared over, by the pg type its description names. */
const endpoints = ["integer", "bigint"] as const
type Endpoint = (typeof endpoints)[number]

type PointInFeature = "admitted" | "refused"

/** A query over Slot whose one predicate is pointIn of a point parameter and a window parameter, as a description. */
const pointInDescription = (pointType: Endpoint, endpoint: Endpoint): QueryDesc =>
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
						point: { kind: "param", name: "point", type: { kind: "pg", type: pointType } },
						span: {
							kind: "param",
							name: "window",
							type: { kind: "span", endpoint: { kind: "pg", type: endpoint }, width: undefined }
						}
					}
				],
				head: { i: { kind: "var", var: "i" } },
				interiors: [],
				attach: []
			}
		]
	})

/** The encoder of a template's only parameter, in both artifacts. */
const encoders = (t: OracleTemplate) =>
	Arr.map([...t.optimized, ...t.conservative], (s) => {
		const slot = s.paramSlots[0]
		if (slot === undefined || s.paramSlots.length !== 1 || slot.kind !== "scalar") {
			throw new Error("one scalar parameter slot")
		}
		return slot.encode
	})

describe("span parameters and windows", () => {
	it.effect(
		"admits a pointIn of two parameters exactly where the point's type is the window's endpoint, at the builder and at the compile",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/spans/point-in-params",
						generator: (source) =>
							[source.draw(element(endpoints)), source.draw(element(endpoints))] as const,
						literal: Formatter.format,
						coverage: requiredInSpace<PointInFeature>(["admitted", "refused"]),
						box: "every pair of a point parameter's type and a window parameter's endpoint, of integer and bigint",
						oracle: {
							kind: "specification",
							name: "nominal compatibility: a point meets a window exactly at the window's endpoint type"
						},
						caseHang
					},
					([pointType, endpoint], c) =>
						Effect.sync(() => {
							const admits = pointType === endpoint
							const built = catchCompileError(() =>
								query(Spans).rule((r) => {
									const { id } = v(Slot, "slot")
									const point =
										pointType === "integer"
											? r.param("point", pg.integer)
											: r.param("point", pg.bigint)
									const window =
										endpoint === "integer"
											? r.param("window", span(pg.integer))
											: r.param("window", span(pg.bigint))
									return r.match(Slot, { id }).where(pointIn(point, window)).find({ id })
								})
							)
							assert.equal(
								built.ok,
								admits,
								`the builder over a ${pointType} point and a ${endpoint} window`
							)
							if (!built.ok) {
								assert.equal(built.error.reason._tag, "MalformedDescription")
							}
							const compiled = compileTemplate(pointInDescription(pointType, endpoint), Spans, {
								...testCompile,
								installation: identity.schema(parsedSchemaName("spans"))
							})
							c.note(admits ? "admitted" : "refused")
							if (admits) {
								assert.ok(compiled.ok, "a point meets a window of its own endpoint type")
								return
							}
							const failure = refused(compiled, "MalformedDescription")
							assert.deepEqual(
								Arr.takeRight(placeOf(refusalLoc(failure)).path, 2),
								["pointIn", "point"],
								"the refusal names pointIn's point"
							)
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
				sentForms(equated.programs.optimized.statement),
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
						oracle: {
							kind: "specification",
							name: "a fixed-width span parameter binds exactly the spans of its width, as [start, end)"
						},
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
						caseHang
					},
					({ start, width }, c) =>
						Effect.sync(() => {
							c.note(width === 15 ? "the column's width" : "another width")
							/** Each statement's encoder of the parameter, of its declared type: the column's fixed-width span. */
							const declared = [...encoders(window), ...encoders(equated)]
							for (const encode of declared) {
								const encoded = encode({ start, end: start + width })
								if (width === 15) {
									assert.deepEqual(encoded, Result.ok(paramText(`[${start},${start + width})`)))
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
