/** What the properties of entry-owner.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { type EntryOwnerCase, shopOf } from "#test/support/families/entry-owner.ts"

/** The shop schema of the entry-owner box, built once. */
export const built = Object.freeze(shopOf("Shop"))

export const id = "00000000-0000-4000-8000-000000000001"

export const caseGen: Gen<EntryOwnerCase> = (source) => {
	const holds = source.draw(element(["neither", "count", "end", "both"] as const))
	const filter = source.draw(
		element(
			holds === "count" || holds === "both"
				? (["region", "label", "count read", "end read"] as const)
				: (["region", "label", "count read", "end read", "count fixed"] as const)
		)
	)
	const op = source.draw(element(["insert", "put", "delete"] as const))
	const fact = source.draw(element(["stated", "count stated"] as const))
	return { holds, filter, op, fact }
}

export type Feature =
	| `refused when declared: its filter reads ${"items" | "stock"}`
	| `${"insert" | "put"} of ${EntryOwnerCase["fact"]} through a declared role`
	| `delete of ${EntryOwnerCase["fact"]} through a declared role, refused when compiled`
	| "a put of the owner in place"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"refused when declared: its filter reads items",
	"refused when declared: its filter reads stock",
	...Arr.flatMap(["insert", "put"] as const, (op) =>
		Arr.map(
			["stated", "count stated"] as const,
			(fact): Feature => `${op} of ${fact} through a declared role`
		)
	),
	...Arr.map(
		["stated", "count stated"] as const,
		(fact): Feature => `delete of ${fact} through a declared role, refused when compiled`
	),
	"a put of the owner in place"
]
