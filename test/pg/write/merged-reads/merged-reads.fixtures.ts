/** What the property of merged-reads.test.ts reads: its schema, its box, the ChangeSet of a case and its model. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"

/** An item and its count, keyed by its id. */
export const Item = relation("Item", { id: pg.integer, n: pg.integer }, ["id"])

export const build = (name: string) =>
	schema(name, [Item], [mutable(Item), unit("Row", { id: pg.integer })])

export type Schema = ReturnType<typeof build>

/** A fact of Item. */
export interface Fact {
	readonly id: number
	readonly n: number
}

/** The stored facts. */
export const stored: ReadonlyArray<Fact> = [
	{ id: 1, n: 10 },
	{ id: 2, n: 20 }
]

/**
 * How the members combine: the insert's ChangeSet sequenced before the delete's, after it, or unioned with it in one
 * stratum; or, as metis's showItem combines its halves, the two sequenced and a third ChangeSet that reads nothing
 * sequenced after them, its put of Item's fact at id 3 the last stratum's.
 */
export type Composition =
	| "insert, then delete"
	| "delete, then insert"
	| "one stratum"
	| "then a put"

/** The insert's fact: a fresh one, or the first stored fact again, an exact repeat that changes nothing. */
export type Inserted = "a fresh fact" | "a stored fact"

/** The delete's fact: a stored fact, or the fact the insert makes, absent from the stored state. */
export type Deleted = "a stored fact" | "the inserted fact"

/**
 * The read-back both members end in, `standing`, over one query: every fact of Item as the state after the change holds
 * it, or every fact of a relation parameter `rows`, free in each member, that the combined ChangeSet binds once to a
 * query of Item's facts, as qti-pie's standing reads the sittings metis binds on its whole call.
 */
export type Standing = "the state" | "a bound relation parameter"

export interface MergedRead {
	readonly composition: Composition
	readonly inserted: Inserted
	readonly deleted: Deleted
	readonly standing: Standing
}

export const mergedReadGen: Gen<MergedRead> = (source) => ({
	composition: source.draw(
		element(["insert, then delete", "delete, then insert", "one stratum", "then a put"] as const)
	),
	inserted: source.draw(element(["a fresh fact", "a stored fact"] as const)),
	deleted: source.draw(element(["a stored fact", "the inserted fact"] as const)),
	standing: source.draw(element(["the state", "a bound relation parameter"] as const))
})

export const situations = [
	"insert, then delete",
	"delete, then insert",
	"one stratum",
	"then a put",
	"a fresh fact",
	"a stored fact",
	"the inserted fact",
	"the state",
	"a bound relation parameter"
] as const

export type Situation = (typeof situations)[number]

/** The fresh fact an insert makes. */
const fresh: Fact = { id: 3, n: 30 }

/** The fact the last stratum's put writes at id 3. */
const putFact: Fact = { id: 3, n: 33 }

const insertedOf = (c: MergedRead): Fact =>
	c.inserted === "a fresh fact" ? fresh : { id: 1, n: 10 }

const deletedOf = (c: MergedRead): Fact =>
	c.deleted === "a stored fact" ? { id: 2, n: 20 } : insertedOf(c)

/** Item's facts, as `standing` reads them, or as the query a bound standing's relation parameter is bound to. */
const itemsOf = (s: Schema): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const { id, n } = varsOver(Item, "item")
		return r.match(Item, { id, n }).find({ id, n })
	})

/** The facts of the relation parameter `rows`, of Item's heading. */
const rowsOf = (s: Schema): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const rows = r.relation("rows", { id: Item.fields.id, n: Item.fields.n })
		const { id, n } = varsOver(rows, "row")
		return r.match(rows, { id, n }).find({ id, n })
	})

/** The insert's ChangeSet and the delete's, each ending in `.read("standing", …)` over one query, combined as the case
 * says. */
const combinedOf = (s: Schema, c: MergedRead): ChangeSetValue => {
	const standing = c.standing === "the state" ? itemsOf(s) : rowsOf(s)
	const insert = ChangeSet.empty(s)
		.insert(Item, [insertedOf(c)])
		.read("standing", () => standing)
	const remove = ChangeSet.empty(s)
		.delete(Item, [deletedOf(c)])
		.read("standing", () => standing)
	switch (c.composition) {
		case "insert, then delete":
			return ChangeSet.sequence(insert, remove)
		case "delete, then insert":
			return ChangeSet.sequence(remove, insert)
		case "one stratum":
			return ChangeSet.union(insert, remove)
		case "then a put":
			return ChangeSet.sequence(
				ChangeSet.sequence(insert, remove),
				ChangeSet.empty(s).put(Item, [putFact])
			)
	}
}

/**
 * The case's ChangeSet, built by the builder's view for a caller whose ChangeSets are known only at run time (one
 * builder, write/changeset/value.ts changeSetOver): the members combined (`combinedOf`), a bound standing's relation
 * parameter then bound once on the whole to a query of Item's facts, evaluated before its first stratum (docs/reads-and-writes.md
 * "Writes").
 */
export const changeOf = (s: Schema, c: MergedRead): ChangeSetValue => {
	const combined = combinedOf(s, c)
	return c.standing === "the state" ? combined : combined.bind({ rows: itemsOf(s) })
}

/** A fact as the property compares it: its fields as text, "id | n". */
export const factText = (f: Fact): string => `${f.id} | ${f.n}`

/** One stratum's writes: its inserted, deleted and put facts. */
interface Stratum {
	readonly inserted: ReadonlyArray<Fact>
	readonly deleted: ReadonlyArray<Fact>
	readonly put: ReadonlyArray<Fact>
}

/** The strata the case's ChangeSet holds, in order. */
const strataOf = (c: MergedRead): ReadonlyArray<Stratum> => {
	const insert: Stratum = { inserted: [insertedOf(c)], deleted: [], put: [] }
	const remove: Stratum = { inserted: [], deleted: [deletedOf(c)], put: [] }
	switch (c.composition) {
		case "insert, then delete":
			return [insert, remove]
		case "delete, then insert":
			return [remove, insert]
		case "one stratum":
			return [{ inserted: [insertedOf(c)], deleted: [deletedOf(c)], put: [] }]
		case "then a put":
			return [insert, remove, { inserted: [], deleted: [], put: [putFact] }]
	}
}

/**
 * The state after the whole ChangeSet, its facts as text in order: each stratum's meaning over the state before it,
 * S' = (S \ D) ∪ A, a put's fact displacing the fact at its key and joining A, so a fact one stratum both inserts and
 * deletes stays (README Strata).
 */
export const modelOf = (c: MergedRead): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(
			Arr.reduce(strataOf(c), stored, (state, stratum) => {
				const gone = (f: Fact) =>
					Arr.some(stratum.deleted, (d) => d.id === f.id && d.n === f.n) ||
					Arr.some(stratum.put, (p) => p.id === f.id)
				const added = [...stratum.inserted, ...stratum.put]
				return [
					...Arr.filter(state, (f) => !gone(f)),
					...Arr.filter(added, (a) => !Arr.some(state, (f) => !gone(f) && f.id === a.id))
				]
			}),
			factText
		),
		Order.String
	)
