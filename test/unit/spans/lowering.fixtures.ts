/** What the properties of lowering.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { identity } from "#compiler/core/identity.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { contract, range, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { decodedQuery } from "#test/support/fixtures/ir/desc.ts"
import { Id } from "#test/support/ids.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"

const instantKey = Symbol("Instant")
const Instant = contract<typeof instantKey>()("Instant", int8)

export const Slot = relation("Slot", { id: int4, room: Id, during: range(int4), at: int4 }, ["id"])

const Visit = relation("Visit", { id: Id, stay: range(Instant), at: Instant }, ["id"])

export const Spans = schema("Spans", [Slot, Visit], [])

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

const Shift = relation("Shift", { id: int4, slot: range(int4, 15), at: int4 }, ["id"])

const Shifts = schema("Shifts", [Shift, Visit], [])

/** The endpoint types a span parameter is declared over, by the pg type its description names. */
export const endpoints = ["int4", "int8"] as const

type Endpoint = (typeof endpoints)[number]

export type PointInFeature = "admitted" | "refused"

/** A query over Slot whose one predicate is pointIn of a point parameter and a window parameter, as a description. */
export const pointInDescription = (pointType: Endpoint, endpoint: Endpoint): QueryDesc =>
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
export const encoders = (t: OracleTemplate) =>
	Arr.map([...t.optimized, ...t.conservative], (s) => {
		const slot = s.paramSlots[0]
		if (slot === undefined || s.paramSlots.length !== 1 || slot.kind !== "scalar") {
			throw new Error("one scalar parameter slot")
		}
		return slot.encode
	})

export const window = compiled(
	query(Shifts).rule((r) => {
		const { id, slot } = v(Shift, "shift")
		return r
			.match(Shift, { id, slot })
			.where(r.allen(slot, ALLEN.intersects, r.param("w", Shift.fields.slot)))
			.find({ id })
	})
)

export const equated = compiled(
	query(Shifts).rule((r) => {
		const { id } = v(Shift, "shift")
		return r.match(Shift, { id, slot: r.param("s", Shift.fields.slot) }).find({ id })
	})
)

/** What the search built once before its cases, now once per worker: every case on it reads them. */
export const equatedChecksNeed = {
	key: "test/unit/spans/lowering.fixtures.ts equatedChecksNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		for (const statement of statements(equated)) {
			assert.ok(has(shapeOf(statement), "predicate = column param"))
		}
		for (const st of Arr.prepend(
			flight(equated.programs.conservative.roots),
			equated.programs.optimized.statement
		)) {
			assert.deepEqual(
				Arr.map(st.params, (slot) => (slot.kind === "scalar" ? slot.sqlType : undefined)),
				[types.int4range]
			)
		}
		return Effect.void
	})
} as const satisfies Need<unknown>
