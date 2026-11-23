/** What the property of oracle.test.ts reads: the situations a span from its ends reaches. */

import { Array as Arr } from "effect"
import {
	type EndsCase,
	endsReferenceRows,
	type SpanEndpointKind,
	spanEndpointKinds
} from "#test/support/oracle/gen/spans.ts"

/**
 * What a case reaches: its form over its endpoint kind, an end of the joined Right span's or a point, a parameter or a
 * literal; and whether some binding's end lies after its start, which yields its span, and some binding's does not,
 * which yields none.
 */
export type EndsFeature =
	| `join:${SpanEndpointKind}`
	| `to:${SpanEndpointKind}:${"param" | "literal"}`
	| "a binding yields its span"
	| "a binding yields none"

/** Every situation the property must reach. */
export const endsFeatures: Arr.NonEmptyReadonlyArray<EndsFeature> = [
	"a binding yields its span",
	"a binding yields none",
	...Arr.flatMap(spanEndpointKinds, (e): ReadonlyArray<EndsFeature> => [
		`join:${e}`,
		`to:${e}:param`,
		`to:${e}:literal`
	])
]

/** The bindings of a case's rule, each its start and end, by the reference's reading of its facts. */
const bindingsOf = (c: EndsCase): ReadonlyArray<readonly [bigint, bigint]> => {
	const q = c.query
	switch (q.kind) {
		case "join":
			return Arr.flatMap(c.facts.Left, (l) =>
				Arr.flatMap(c.facts.Right, (r) =>
					r.group === l.group ? [[l.during.lo, r.during.hi] as const] : []
				)
			)
		case "to":
			return Arr.map(c.facts[q.relation], (f) => [f.during.lo, q.end.point] as const)
	}
}

/** What a case reaches (EndsFeature). */
export const endsFeaturesOf = (c: EndsCase): ReadonlyArray<EndsFeature> => {
	const q = c.query
	const form: EndsFeature =
		q.kind === "join" ? `join:${c.schema.endpoint}` : `to:${c.schema.endpoint}:${q.end.kind}`
	const bindings = bindingsOf(c)
	return [
		form,
		...(Arr.some(bindings, ([start, end]) => start < end)
			? ["a binding yields its span" as const]
			: []),
		...(Arr.some(bindings, ([start, end]) => start >= end)
			? ["a binding yields none" as const]
			: [])
	]
}

export { endsReferenceRows }
