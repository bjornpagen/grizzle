/** What the properties of params.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { int4, int8 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { describedDesc } from "#compiler/schema/protocol.ts"

/** How a member declares the relation parameter's fields: b, c and d, b and c, c before b, or d as a bigint. */
type Declared = "b, c, d" | "b, c" | "c, b, d" | "b, c, d as a bigint"

const headingOf = {
	"b, c, d": { b: int4, c: int4, d: int4 },
	"b, c": { b: int4, c: int4 },
	"c, b, d": { c: int4, b: int4, d: int4 },
	"b, c, d as a bigint": { b: int4, c: int4, d: int8 }
} as const

/** The fields a heading declares, each with the FieldDesc its builder recorded, in name order. */
export const fieldsOf = (declared: Declared) => {
	const heading: Readonly<Record<string, unknown>> = headingOf[declared]
	return Arr.sort(
		Arr.map(Rec.toEntries(heading), ([name, field]) => ({
			name,
			desc: describedDesc(field, name)
		})),
		Order.mapInput(Order.String, (f: { readonly name: string }) => f.name)
	)
}

export const R = relation("R", { b: int4, c: int4, d: int4 }, ["b", "c"])

export const S = relation("S", { b: int4, c: int4, d: int4 }, ["b", "c"])

export const Pair = schema("Pair", [R, S], [])

/** The facts of `rows`, declared under `declared`, each at its b and c, its d 1. */
export const fromRows = (declared: Declared, target: typeof R | typeof S) =>
	query(Pair).rule((r: RuleValue) => {
		const { b, c } = v(target, "row")
		return r.match(r.relation("rows", headingOf[declared]), { b, c }).find({ b, c, d: 1 })
	})

const declaredList = ["b, c, d", "b, c", "c, b, d", "b, c, d as a bigint"] as const

export const caseGen: Gen<readonly [Declared, Declared]> = (source) =>
	[source.draw(element(declaredList)), source.draw(element(declaredList))] as const

export type ParamFeature = "one heading" | "a heading within the other" | "a field of another type"
