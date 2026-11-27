/** What variant-subset.test.ts reads: its roster, its box of arms records and the subset each names. */

import { type Gen, int, map, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { trusted } from "#compiler/core/trusted.ts"
import { pg, type VariantArms, variant } from "#compiler/public/fields.ts"
import { closed } from "#compiler/public/schema.ts"

/** The roster's handles, in its order. */
export const handles = ["p", "q", "r", "s"] as const

/** A handle of the roster. */
export type Handle = (typeof handles)[number]

/** The roster every case's variant is tagged by. */
const Mark = closed.ordered("Mark", handles)

/** A handle of no roster of the case's. */
const foreign = "t"

/**
 * A case: the handles its arms record names, in the order it lists them, each arm one integer field `value`:
 * - `typed`: an ordered list of distinct handles of the roster, of none or more, which a caller's TypeScript writes as
 *   the record's keys in that order;
 * - `foreign`: such a list with a handle off the roster written at some place in it, which only a JavaScript caller
 *   writes.
 */
export type Listing =
	| { readonly door: "typed"; readonly listed: ReadonlyArray<Handle> }
	| { readonly door: "foreign"; readonly listed: ReadonlyArray<string> }

/** The box: every ordered list of distinct handles of the four, none among them, and each with a handle off the roster. */
export const listings: Gen<Listing> = oneOf<Listing>([
	map(shuffled(handles, { min: 0, max: handles.length }), (listed) => ({ door: "typed", listed })),
	(s) => {
		const listed = s.draw(shuffled(handles, { min: 0, max: handles.length }))
		const at = s.draw(int(0, listed.length))
		return {
			door: "foreign",
			listed: [...Arr.take(listed, at), foreign, ...Arr.drop(listed, at)]
		}
	}
])

/**
 * The arms record a listing writes, its keys in the listing's order, each arm one integer field: the record a caller
 * hands variant, which its type would refuse where it names a handle off the roster or none, so it reaches the
 * constructor as a JavaScript caller's value.
 */
const armsOf = (listed: ReadonlyArray<string>): VariantArms<typeof Mark> =>
	trusted<VariantArms<typeof Mark>>(
		Rec.fromEntries(Arr.map(listed, (handle) => [handle, { value: pg.integer }] as const))
	)

/** The variant a listing states, built by the public constructor. */
export const variantOf = (listed: ReadonlyArray<string>) => variant("Marked", Mark, armsOf(listed))

/** The subset a typed listing names, as the specification reads it: its handles in the roster's order. */
export const namedBy = (listed: ReadonlyArray<Handle>): ReadonlyArray<Handle> =>
	Arr.filter(handles, (handle) => listed.includes(handle))
