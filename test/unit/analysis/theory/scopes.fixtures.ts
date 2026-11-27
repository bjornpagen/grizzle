/** What the property of scopes.test.ts reads: its box, its model and its schema. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	contained,
	f,
	on,
	relation,
	type SchemaDesc,
	unit
} from "#test/support/fixtures/ir/desc.ts"
import { schemaOf } from "#test/unit/analysis/theory/support.ts"

/**
 * One case of the box: the unit U over `k`, or none; A, a clock of child (k) or (k, j); B, a clock of child (k); C, a
 * clock of child (c), which no unit's heading leads; and R, keyed by r, whose `at` is a reference A's clock stamps at
 * the child R carries to A's.
 */
export interface ScopesCase {
	readonly unit: "U" | "none"
	readonly aChild: "k" | "k,j"
}

export const scopesGen: Gen<ScopesCase> = (source) => ({
	unit: source.draw(element(["U", "none"] as const)),
	aChild: source.draw(element(["k", "k,j"] as const))
})

/** A's child's fields, in key order. */
const aChildOf = (c: ScopesCase): ReadonlyArray<string> => (c.aChild === "k" ? ["k"] : ["k", "j"])

/** The case's schema: A, B, C and R, R's containment into A, and U where the case declares it. */
export const scopesSchema = (c: ScopesCase): SchemaDesc => {
	const child = aChildOf(c)
	return schemaOf(
		[
			relation("A", { k: f.integer, j: f.integer, at: f.instant }, [...child, "at"]),
			relation("B", { k: f.integer, at: f.instant }, ["k", "at"]),
			relation("C", { c: f.integer, at: f.instant }, ["c", "at"]),
			relation("R", { r: f.integer, k: f.integer, j: f.integer, at: f.instant }, ["r"])
		],
		[
			contained(on("R", [...child, "at"]), on("A", [...child, "at"])),
			...(c.unit === "U" ? [unit("U", { k: f.integer })] : [])
		]
	)
}

/** A scope as the model states it: a unit's, by name, or a clock's own child's, by its clock; and its key's fields. */
export interface ModelScope {
	readonly scope: string
	readonly key: ReadonlyArray<string>
}

/**
 * The rule over the case: A and B, whose keys lead with k, sit in U where the case declares it, and share its scope,
 * keyed (k); every other clock is its own child's scope; R's reference is stamped from A's scope at R's fields that hold
 * its key. The heads are each scope once.
 */
export const modelOf = (
	c: ScopesCase
): {
	readonly clocks: ReadonlyMap<string, ModelScope>
	readonly reference: ModelScope
	readonly heads: number
} => {
	const own = (clock: string, key: ReadonlyArray<string>): ModelScope => ({
		scope: `${clock}.at`,
		key
	})
	const inUnit = c.unit === "U"
	const unitScope: ModelScope = { scope: "unit U", key: ["k"] }
	const a = inUnit ? unitScope : own("A", aChildOf(c))
	return {
		clocks: new Map([
			["A", a],
			["B", inUnit ? unitScope : own("B", ["k"])],
			["C", own("C", ["c"])]
		]),
		reference: a,
		heads: inUnit ? 2 : 3
	}
}

export type ScopesFeature =
	| "a unit's two clocks share its head"
	| "a unit's clock of a child longer than its key"
	| "clocks of no unit, each its own child's"
	| "a clock outside the unit beside its clocks"
	| "a reference stamped at its unit's key"

export const scopesNotes = (c: ScopesCase): ReadonlyArray<ScopesFeature> =>
	c.unit === "U"
		? [
				"a unit's two clocks share its head",
				"a clock outside the unit beside its clocks",
				"a reference stamped at its unit's key",
				...(c.aChild === "k,j" ? (["a unit's clock of a child longer than its key"] as const) : [])
			]
		: ["clocks of no unit, each its own child's"]

/** A scope's fields as their names, in order. */
export const names = (fields: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<string> =>
	Arr.map(fields, (x) => x.name)
