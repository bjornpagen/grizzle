/** What the properties of choose.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { key, mutable, on, relation, schema, select, unit } from "#compiler/public/schema.ts"
import { queryOver as query, type QueryValue, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import type { PutChoice } from "#compiler/write/put/choose.ts"

/** The unique objects of R beside its primary key. */
type Uniques = "none" | "key(c)" | "key over a selected primary key" | "key(d)"

/** How the ChangeSet puts R, in one stratum. */
type Form =
	| "replace"
	| "replace beside an insert"
	| "own facts"
	| "own facts beside a deletion"
	| "enumerated"
	| "enumerated after an insert in an earlier stratum"

/** The statement a put lowers to, and why. */
export interface Choice {
	readonly target: PutChoice["target"]
	readonly reason: PutChoice["reason"]
}

/** A choice's feature: its statement and its reason. */
export type ChoiceFeature = `${PutChoice["target"]} (${PutChoice["reason"]})`

export const featureOf = (c: Choice): ChoiceFeature => `${c.target} (${c.reason})`

const R = relation("R", { b: pg.integer, c: pg.integer, d: pg.integer }, ["b", "c"])

export const schemaOf = (uniques: Uniques) =>
	schema(
		"Put",
		[R],
		[
			unit("Bs", { b: pg.integer }),
			mutable(R),
			...(uniques === "key(c)"
				? [key(on(R, "c"))]
				: uniques === "key over a selected primary key"
					? [
							key(
								on(
									select(R, (r) => r.eq(r.b, 1)),
									"b",
									"c"
								)
							)
						]
					: uniques === "key(d)"
						? [key(on(R, "d"))]
						: [])
		]
	)

/** The facts of the relation parameter `rows`, put as they are. */
const fromRows = (s: ReturnType<typeof schemaOf>): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, c, d } = v(R, "row")
		return r.match(r.relation("rows", R), { b, c, d }).find({ b, c, d })
	})

/** Every stored fact of R with d = $scope whose key the relation parameter `rows` lacks. */
const scopedOutside = (s: ReturnType<typeof schemaOf>): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, c, d } = v(R, "stored")
		return r
			.match(R, { b, c, d })
			.where(r.eq(d, r.param("scope", pg.integer)))
			.where(r.not(r.relation("rows", R), { b, c }))
			.find({ b, c, d })
	})

/** Every stored fact of R, its d set to 1: a put whose every key is a stored fact's. */
const ownFacts = (s: ReturnType<typeof schemaOf>): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, c, d } = v(R, "stored")
		return r.match(R, { b, c, d }).find({ b, c, d: 1 })
	})

/** Every stored fact of R with d = 0. */
const zeroFacts = (s: ReturnType<typeof schemaOf>): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, c } = v(R, "stored")
		return r.match(R, { b, c, d: 0 }).find({ b, c, d: 0 })
	})

/** The ChangeSet of a form, R's first put first. */
export const changeSetOf = (s: ReturnType<typeof schemaOf>, form: Form) => {
	const empty = ChangeSet.empty(s)
	switch (form) {
		case "replace":
			return empty.put(R, fromRows(s)).delete(R, scopedOutside(s))
		case "replace beside an insert":
			return empty
				.put(R, fromRows(s))
				.delete(R, scopedOutside(s))
				.insert(R, [{ b: 9, c: 9, d: 9 }])
		case "own facts":
			return empty.put(R, ownFacts(s))
		case "own facts beside a deletion":
			return empty.put(R, ownFacts(s)).delete(R, zeroFacts(s))
		case "enumerated":
			return empty.put(R, [{ b: 1, c: 1, d: 1 }])
		case "enumerated after an insert in an earlier stratum":
			return ChangeSet.sequence(
				empty.insert(R, [{ b: 2, c: 2, d: 2 }]),
				empty.put(R, [{ b: 1, c: 1, d: 1 }])
			)
	}
}

/** The rules of the header, over the box's names: R's first put's statement and its reason. */
export const expectedOf = (uniques: Uniques, form: Form): Choice => {
	if (uniques === "key(d)") {
		return { target: "deleteThenInsert", reason: "candidateKey" }
	}
	switch (form) {
		case "replace":
			return uniques === "key(c)"
				? { target: "deleteThenInsert", reason: "mergeUnique" }
				: { target: "merge", reason: "scopedMerge" }
		case "replace beside an insert":
		case "own facts beside a deletion":
			return { target: "deleteThenInsert", reason: "unproved" }
		case "own facts":
			return { target: "updateFrom", reason: "existingKeys" }
		case "enumerated":
			return { target: "onConflictDoUpdate", reason: "enumerated" }
		case "enumerated after an insert in an earlier stratum":
			return { target: "deleteThenInsert", reason: "netting" }
	}
}

const uniquesList: Arr.NonEmptyReadonlyArray<Uniques> = [
	"none",
	"key(c)",
	"key over a selected primary key",
	"key(d)"
]

const forms: Arr.NonEmptyReadonlyArray<Form> = [
	"replace",
	"replace beside an insert",
	"own facts",
	"own facts beside a deletion",
	"enumerated",
	"enumerated after an insert in an earlier stratum"
]

export const caseGen: Gen<readonly [Uniques, Form]> = (source) =>
	[source.draw(element(uniquesList)), source.draw(element(forms))] as const
