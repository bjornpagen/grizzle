/** What the property of merged-members.test.ts reads: its schema, its box, the write of a case and its model. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { instant, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"

/** A child's moment, its at a clock of child `child`: qti's TestMoment. */
export const Moment = relation("Moment", { child: int4, at: instant }, ["child", "at"])

/** A child's budget at its visit `k`, its at a reference Moment's clock stamps at its child: qti's TestBudget. */
export const Budget = relation("Budget", { child: int4, k: int4, remaining: int4, at: instant }, [
	"child",
	"k"
])

/**
 * A child's earlier note at a stored moment, keyed by the moment, so a delete states the instant of its key: mutable,
 * inside the unit of its child, which Moment and Budget sit in too.
 */
export const Old = relation("Old", { child: int4, at: instant, n: int4 }, ["child", "at"])

export const build = (name: string) =>
	schema(
		name,
		[Moment, Budget, Old],
		[
			contained(on(Budget, "child", "at"), on(Moment, "child", "at")),
			contained(on(Old, "child", "at"), on(Moment, "child", "at")),
			mutable(Old),
			unit("Learner", { child: int4 })
		]
	)

export type Schema = ReturnType<typeof build>

/** A budget as a member gives it, its at left out for the stratum's stamp. */
export interface Given {
	readonly child: number
	readonly k: number
	readonly remaining: number
}

/** The sources of the stratum's inserts of Budget: two queries, three, or two queries beside host rows. */
export type Members = "two queries" | "three queries" | "two queries and host rows"

/**
 * How the sources' budgets meet: at keys no other source gives and none stored; one fact two sources give; two
 * facts of one key from two sources; a source's fact equal to Budget's stored one at every field it states, an exact
 * repeat; or one at the stored key that differs there.
 */
export type Overlap =
	| "disjoint"
	| "a shared fact"
	| "two facts at one key"
	| "a stored fact"
	| "a stored key"

export interface Merged {
	readonly members: Members
	readonly overlap: Overlap
}

export const mergedGen: Gen<Merged> = (source) => ({
	members: source.draw(
		element(["two queries", "three queries", "two queries and host rows"] as const)
	),
	overlap: source.draw(
		element([
			"disjoint",
			"a shared fact",
			"two facts at one key",
			"a stored fact",
			"a stored key"
		] as const)
	)
})

export const situations = [
	"two queries",
	"three queries",
	"two queries and host rows",
	"disjoint",
	"a shared fact",
	"two facts at one key",
	"a stored fact",
	"a stored key"
] as const

export type Situation = (typeof situations)[number]

/** The children the stratum stamps a moment of, from host rows. */
export const children: ReadonlyArray<number> = [1, 2]

/** The stored moments, each a child's and its instant's, microseconds since the epoch as an instant is stored (2026-01-01,
 * -02 and -03), each before the call's at each child, a child's in the order of their instants: a seed stamps each in a
 * transaction of its own first, as every writer of Moment stamps its clock (physical/ddl/clocked.ts). */
export const storedMoments: ReadonlyArray<readonly [number, string]> = [
	[1, "1767225600000000"],
	[1, "1767312000000000"],
	[2, "1767398400000000"]
]

/** The stored notes, each at a stored moment, the first two the deletes name by their n. */
export const storedOld: ReadonlyArray<readonly [number, string, number]> = [
	[1, "1767225600000000", 1],
	[1, "1767312000000000", 2],
	[2, "1767398400000000", 3]
]

/** The stored budget, at the first stored moment. */
export const storedBudget: readonly [number, number, number, string] = [1, 3, 9, "1767225600000000"]

/** The ns the stratum's two deletes of Old name, one each. */
export const deletedNs: readonly [number, number] = [1, 2]

/** The facts two sources give beside their own, by how they meet. */
const meetOf = (overlap: Overlap): readonly [ReadonlyArray<Given>, ReadonlyArray<Given>] => {
	switch (overlap) {
		case "disjoint":
			return [[], []]
		case "a shared fact":
			return [[{ child: 2, k: 4, remaining: 6 }], [{ child: 2, k: 4, remaining: 6 }]]
		case "two facts at one key":
			return [[{ child: 2, k: 4, remaining: 6 }], [{ child: 2, k: 4, remaining: 7 }]]
		case "a stored fact":
			return [[{ child: storedBudget[0], k: storedBudget[1], remaining: storedBudget[2] }], []]
		case "a stored key":
			return [[{ child: storedBudget[0], k: storedBudget[1], remaining: storedBudget[2] + 1 }], []]
	}
}

/** The budgets a case's sources give: each query source's, in order, and its host rows', none but where it has them. */
interface Sources {
	readonly queried: ReadonlyArray<NonEmptyReadonlyArray<Given>>
	readonly host: ReadonlyArray<Given>
}

/**
 * The budgets each source gives, by the case: every source some fact of its own, so no two queries are one member, and
 * the overlap's facts beside them.
 */
const sourcesOf = (c: Merged): Sources => {
	const [one, two] = meetOf(c.overlap)
	const first: NonEmptyReadonlyArray<Given> = [
		{ child: 1, k: 0, remaining: 5 },
		{ child: 2, k: 1, remaining: 6 },
		...one
	]
	const second: NonEmptyReadonlyArray<Given> = [{ child: 1, k: 1, remaining: 7 }, ...two]
	switch (c.members) {
		case "two queries":
			return { queried: [first, second], host: [] }
		case "three queries":
			return { queried: [first, second, [{ child: 2, k: 2, remaining: 8 }]], host: [] }
		case "two queries and host rows":
			return { queried: [first, second], host: [{ child: 2, k: 5, remaining: 1 }] }
	}
}

/** The relation parameter a query source of Budget reads its budgets from, by its place among the sources. */
const sourceNames = ["first", "second", "third"] as const

/** A query source of Budget: the budgets of its relation parameter `name`. */
const sourceQuery = (s: Schema, name: (typeof sourceNames)[number]) =>
	query(s).rule((r) => {
		const rows = r.relation(name, { child: int4, k: int4, remaining: int4 })
		const { child, k, remaining } = v(rows, "given")
		return r.match(rows, { child, k, remaining }).find({ child, k, remaining })
	})

/** The stored notes whose n is `n`, each field, its instant a stored one. */
const oldOf = (s: Schema, n: number) =>
	query(s).rule((r) => {
		const { child, at, n: stored } = v(Old, "old")
		return r
			.match(Old, { child, at, n: stored })
			.where(r.eq(stored, n))
			.find({ child, at, n: stored })
	})

/**
 * The case's one stratum, enterTest's shape: a moment of each child from host rows, which stamps Moment's clock; two
 * deletes of Old, each from a query of the notes of one n; Budget's sources, each a member of its insert, which
 * Moment's clock stamps at its child: two queries, a third, or host rows beside them; and the moments it added, read
 * back as enterTest reads its visits.
 */
export const writeOf = (s: Schema, c: Merged) => {
	const stratum = ChangeSet.empty(s)
		.insert(
			Moment,
			Arr.map(children, (child) => ({ child }))
		)
		.delete(Old, oldOf(s, deletedNs[0]))
		.delete(Old, oldOf(s, deletedNs[1]))
		.insert(Budget, sourceQuery(s, "first"))
		.insert(Budget, sourceQuery(s, "second"))
		.read("entered", (delta) =>
			query(s).rule((r) => {
				const { child, at } = v(delta.added(Moment), "entered")
				return r.match(delta.added(Moment), { child, at }).find({ child, at })
			})
		)
	switch (c.members) {
		case "two queries":
			return stratum
		case "three queries":
			return stratum.insert(Budget, sourceQuery(s, "third"))
		case "two queries and host rows":
			return stratum.insert(Budget, sourcesOf(c).host)
	}
}

/** The call's parameters: each query source's budgets under its name. */
export const paramsOf = (c: Merged): Readonly<Record<string, ReadonlyArray<Given>>> =>
	Rec.fromEntries(
		Arr.zipWith(sourceNames, sourcesOf(c).queried, (name, given) => [name, given] as const)
	)

/**
 * What the write does by its meaning, S' = (S \ D) ∪ A over the stratum's one snapshot: refused on Budget's key where
 * its sources' facts hold two at one key, or one at the stored key that differs at a field it states (README, "Rows an
 * insertion met"); and otherwise the facts they give, each once, at its child's one new instant, but an exact repeat of
 * the stored budget, which stays as stored, and the notes the deletes name gone.
 */
export type Model =
	| { readonly kind: "refused" }
	| { readonly kind: "accepted"; readonly budgets: ReadonlyArray<Given> }

const keyOf = (g: Given): string => `${g.child}/${g.k}`

/** The stored budget as a source would give it. */
const stored: Given = { child: storedBudget[0], k: storedBudget[1], remaining: storedBudget[2] }

const sameFact = (a: Given, b: Given): boolean =>
	a.child === b.child && a.k === b.k && a.remaining === b.remaining

export const modelOf = (c: Merged): Model => {
	const sources = sourcesOf(c)
	const facts = Arr.dedupeWith([...Arr.flatten(sources.queried), ...sources.host], sameFact)
	const keys = new Set(Arr.map(facts, keyOf))
	const conflicts =
		keys.size < facts.length ||
		Arr.some(facts, (f) => keyOf(f) === keyOf(stored) && !sameFact(f, stored))
	return conflicts
		? { kind: "refused" }
		: { kind: "accepted", budgets: Arr.filter(facts, (f) => !sameFact(f, stored)) }
}
