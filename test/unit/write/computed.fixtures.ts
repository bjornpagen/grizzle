/** What the property of computed.test.ts reads: its box and the write of each case. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import { contract, drawn, natural, int4, int8 } from "#compiler/public/fields.ts"
import { param } from "#compiler/public/query.ts"
import { fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

const spanKey = Symbol("Span")
/** A span a call adds to its clock's reading, bounded by its predicate, so a millis reading plus it fits a bigint with no
 * guard (core/clock.ts clockReadingRange). */
const Span = contract<typeof spanKey>()("Span", int8, (d) =>
	Logic.and([Logic.ge(d, 0n), Logic.le(d, 10n ** 12n)])
)

/** The call's reading of the database's clock plus the parameter `by`, cast into bigint with no guard, as den's lease. */
const after = <const By extends string>(by: By) =>
	Type.cast(Num.add(Type.base(param("now", int8)), Type.base(param(by, Span))), int8)

/** How deep the insert's rows nest: no family, one sequence of members, or members nesting members of their own. */
type Depth = 0 | 1 | 2

/** Which field the insert computes: a payload field of its own rows alone, or a field of its owner's key every member
 * carries. */
type Where = "payload" | "key"

export interface Computing {
	readonly depth: Depth
	readonly where: Where
}

export type ComputingFeature =
	| "depth 0"
	| "depth 1"
	| "depth 2"
	| "a payload field computed"
	| "a key field computed, members carrying it"

export const computingGen: Gen<Computing> = (source) => ({
	depth: source.draw(element([0, 1, 2] as const)),
	where: source.draw(element(["payload", "key"] as const))
})

export const computingFeatures = (c: Computing): ReadonlyArray<ComputingFeature> => [
	c.depth === 0 ? "depth 0" : c.depth === 1 ? "depth 1" : "depth 2",
	c.where === "payload" ? "a payload field computed" : "a key field computed, members carrying it"
]

/**
 * The case's schema, the relations its insert writes rows of, and its write: Owner(q, due, until) keyed (q, due), its
 * members M1(q, due, at, v) from depth 1 and M2(q, due, at, bt, w) at depth 2, each carrying its owner's key, its
 * insert computing `until`, or `due` with it, built as a JavaScript caller builds it (write/changeset/value.ts).
 */
export const computingOf = (c: Computing) => {
	const Spans = relation("Spans", { span: Span }, ["span"])
	const key = { q: int4, due: int8 }
	const S = ((): AnySchema => {
		switch (c.depth) {
			case 0: {
				const Owner = relation("Owner", { ...key, until: int8 }, ["q", "due"])
				return schema("Computing", [Spans, Owner], [])
			}
			case 1: {
				const Owner = relation("Owner", { ...key, until: int8, ms: drawn(natural) }, ["q", "due"])
				const M1 = relation("M1", { ...key, at: drawn(natural), v: int4 }, ["q", "due", "at"])
				return schema(
					"Computing",
					[Spans, Owner, M1],
					[ordered(on(M1, "q", "due", "at"), fin(Owner, "ms"))]
				)
			}
			case 2: {
				const Owner = relation("Owner", { ...key, until: int8, ms: drawn(natural) }, ["q", "due"])
				const M1 = relation("M1", { ...key, at: drawn(natural), v: int4, ns: drawn(natural) }, [
					"q",
					"due",
					"at"
				])
				const M2 = relation("M2", { ...key, at: natural, bt: drawn(natural), w: int4 }, [
					"q",
					"due",
					"at",
					"bt"
				])
				return schema(
					"Computing",
					[Spans, Owner, M1, M2],
					[
						ordered(on(M1, "q", "due", "at"), fin(Owner, "ms")),
						ordered(on(M2, "q", "due", "at", "bt"), fin(M1, "ns"))
					]
				)
			}
		}
	})()
	const computed =
		c.where === "payload"
			? { until: after("budget") }
			: { due: after("delay"), until: after("budget") }
	return {
		schema: S,
		/** The relations whose rows carry a computed field: the owner's, and every member's where its key's `due` is one. */
		carrying: c.where === "key" ? ["Owner", "M1", "M2"].slice(0, c.depth + 1) : ["Owner"],
		changeSet: () => ChangeSet.empty(S).insertAllComputed({ Owner: [] }, computed)
	}
}
