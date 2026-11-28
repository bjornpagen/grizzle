/** What the properties of guarded-span.test.ts read: its spaces, models and helpers. */

import { boolean, type Gen, shuffled } from "@bjornpagen/testing/gen"
import { range, int4, int8 } from "#compiler/public/fields.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { keyBuilder, onBuilder, selectBuilder } from "#compiler/schema/statements.ts"
import type { rowHelpers, RowTerm } from "#compiler/schema/terms.ts"
import { Id } from "#test/support/ids.ts"

/** A span key of T: over every fact or a selection of them, and the scalars it compares beside its span, in order. */
interface SpanKey {
	readonly selected: boolean
	readonly scalars: ReadonlyArray<"a" | "b">
}

export const spanKeyGen: Gen<SpanKey> = (source) => ({
	selected: source.draw(boolean),
	scalars: source.draw(shuffled(["a", "b"] as const, { min: 0, max: 2 }))
})

type TRow = { readonly kind: RowTerm } & typeof rowHelpers

/** The schema whose one relation T states the span key `k`. */
export const schemaOf = (k: SpanKey) => {
	const T = relation("T", { id: Id, kind: int4, a: Id, b: int4, during: range(int8) }, ["id"], [])
	const side = k.selected ? selectBuilder(T, (r: TRow) => r.eq(r.kind, 1)) : T
	return schema("GuardedSpan", [T], [keyBuilder(onBuilder(side, [...k.scalars, "during"]))], [])
}

export type Feature =
	| "a span-alone key over a selection"
	| "a span-alone key over every fact"
	| "a guarded span key with a scalar"
	| "a span key with a scalar over every fact"
