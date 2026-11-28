/** What the properties of attnums.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Record as Rec } from "effect"
import { int2, int4 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { tableMaxColumns } from "#compiler/write/carriers/carriers.ts"
import { upTo } from "#test/support/up-to.ts"

/** PostgreSQL's limit on a table's attribute numbers, live and dropped (htup_details.h MaxHeapAttributeNumber). */
export const maxAttributes = tableMaxColumns

/** The columns of a version: `prefix0 … prefix(n − 1)`, each int2, beside the key. */
export const columnsOf = (prefix: string, n: number): ReadonlyArray<string> =>
	upTo(n, (i) => `${prefix}${i}`)

/** A wide relation of its key and the given int2 columns. */
export const wide = (name: string, columns: ReadonlyArray<string>) =>
	schema(
		name,
		[
			relation(
				"Wide",
				{ id: int4, ...Rec.fromEntries(Arr.map(columns, (c) => [c, int2] as const)) },
				["id"]
			)
		],
		[]
	)

/** How many attribute numbers the migrated table leaves below the bound. */
export const slack = 2

/** How many columns past the slack an addition reaches at most. */
export const past = 2

/** The first version's columns, 799 beside the key: 800 attribute numbers. */
export const first = columnsOf("a", maxAttributes / 2 - 1)

/** The second version's: every first column dropped, and 798 new ones: the slack below the bound in all. */
export const second = columnsOf("b", maxAttributes / 2 - slack)

/** Where an addition's attribute numbers end against the bound. */
export type BoundPlace =
	| "below the bound"
	| "on the bound"
	| "one past the bound"
	| "further past the bound"

/** Where the addition of `added` columns to the migrated table ends. */
export const boundPlaceOf = (added: number): BoundPlace => {
	const end = maxAttributes - slack + added
	if (end < maxAttributes) {
		return "below the bound"
	}
	if (end === maxAttributes) {
		return "on the bound"
	}
	return end === maxAttributes + 1 ? "one past the bound" : "further past the bound"
}
