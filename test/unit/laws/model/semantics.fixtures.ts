/** What the properties of semantics.test.ts read: its spaces, models and helpers. */

/** A closed relation over a roster: none, or one value of a bigint payload per handle that has a row. */
export type Payload =
	| { readonly kind: "none" }
	| { readonly kind: "values"; readonly values: ReadonlyArray<bigint> }
