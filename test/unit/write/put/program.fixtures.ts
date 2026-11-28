/** What the properties of program.test.ts read: its spaces, models and helpers. */

import { array, constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { Item, Stock } from "#test/support/unit/write/put/support.ts"

/** The described members whose relation parameter the program binds: Item's insert under items (Item is closed, its
 * facts only inserted), Stock's put under stocks. */
export const parameterMembers = [
	{ relation: Item, param: "items", op: "insert" },
	{ relation: Stock, param: "stocks", op: "put" }
] as const

/** What the caller gives a parameter: facts, nothing, or a value that is no list. */
type Given =
	| { readonly kind: "facts"; readonly facts: ReadonlyArray<number> }
	| { readonly kind: "left out" }
	| { readonly kind: "a number" }

export const givenGen: Gen<Given> = weighted<Given>([
	[2, (source) => ({ kind: "facts", facts: source.draw(array(int(1, 3), { min: 0, max: 3 })) })],
	[1, constant({ kind: "left out" })],
	[1, constant({ kind: "a number" })]
])

export const fact = (n: number, qty: bigint) => ({ id: uuidOf(n), label: "a", qty })

export type ParamFeature =
	| "every parameter given"
	| "a parameter left out"
	| "a parameter given a number"
