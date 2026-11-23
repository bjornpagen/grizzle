/** What the properties of facts.test.ts read: its spaces, models and helpers. */

import { deepEquals } from "@bjornpagen/testing/assert"
import { element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { pg } from "#compiler/public/fields.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

/**
 * A served ChangeSet's array members take each call's facts (its input's `facts`), keyed by each member's op and then
 * its relation, generated: a change member inserting into one relation and putting and deleting facts of another, each
 * through an array member, is loaded as a handle that takes the call's facts beside its parameters, and a call through
 * it writes exactly the facts it supplies, each under its own op.
 *
 * - Shape: the member loads as a change whose calls take their facts (served/load.ts ChangeCall `facts`), decided once
 *   at load by its array members.
 * - Oracle: after a call over stored items, the items stored are the stored ones less those the call deletes, with the
 *   ones it puts, which no stored item shares a key with, and the labels stored are the ones it inserts.
 * - Faults: a case may plant a fault at the handle, which loses one member's facts, its array emptied or its relation
 *   left out of its op's record, or passes the put's facts as the delete's and the delete's as the put's; the oracle
 *   must then disagree with what the call did, a refusal (memberFactsOf at the member's slot) or a store without them.
 *
 * Essay ideas: an oracle (the facts a call supplies are the facts it writes, each by its op) over generated facts, with
 * faults planted at the handle that the oracle must catch.
 */
const Tag = str.regex("^[a-z]{1,4}$")

export const Item = relation("Item", { id: pg.integer, score: pg.integer }, ["id"])

export const Label = relation("Label", { item: pg.integer, tag: Tag }, ["item", "tag"])

export const Labels = schema(
	"Labels",
	[Item, Label],
	[mutable(Item), unit("Scored", { id: pg.integer })]
)

/** What every case installs: Labels, its login's workload holding no member of its own. */
export const labelsInstall = { label: "labels", programs: {} } as const

/** Labels installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const labelsTemplate = fixtureTemplate(import.meta, Labels, labelsInstall)

const tags = ["a", "bc", "def", "ghij"] as const

/** An item as stored and as a call states it, a fact of Item. */
type ItemFact = Readonly<{ id: number; score: number }>

/** A label as a call states it, a fact of Label. */
type LabelFact = Readonly<{ item: number; tag: string }>

/** One call's facts: under each op, one array under its array member's relation, each nonempty and of distinct keys. */
interface CallFacts {
	readonly insert: { readonly Label: ReadonlyArray<LabelFact> }
	readonly put: { readonly Item: ReadonlyArray<ItemFact> }
	readonly delete: { readonly Item: ReadonlyArray<ItemFact> }
}

/** A case: the items stored before the call, and the call's facts, whose deletes are stored items and whose puts are
 * items of keys none stored. */
interface FactsCase {
	readonly stored: ReadonlyArray<ItemFact>
	readonly facts: CallFacts
}

/** An array member of the change, by its op and relation. */
type MemberKey = "insert" | "put" | "delete"

/** A fault planted at the handle: none, one member's facts emptied or left out, or the put's and delete's swapped. */
type Plant =
	| { readonly kind: "none" }
	| { readonly kind: "emptied"; readonly member: MemberKey }
	| { readonly kind: "omitted"; readonly member: MemberKey }
	| { readonly kind: "swapped" }

export type Feature =
	| "no plant"
	| "a member's facts emptied"
	| "a member's facts omitted"
	| "the put's and delete's facts swapped"

/** Between one and five items of distinct ids among `ids`, in the order drawn, each with a score. */
const itemsGen =
	(ids: ReadonlyArray<number>): Gen<ReadonlyArray<ItemFact>> =>
	(source) =>
		Arr.map(source.draw(shuffled(ids, { min: 1, max: 5 })), (id) => ({
			id,
			score: source.draw(int(-5, 5))
		}))

/** The ids stored items take, and the ids a call's puts take, which no stored item shares. */
const storedIds: Arr.NonEmptyReadonlyArray<number> = Arr.range(1, 40)

const putIds: Arr.NonEmptyReadonlyArray<number> = Arr.range(41, 80)

/** Every label a call may insert: each item 1 to 6 under each tag. */
const labelFacts: ReadonlyArray<LabelFact> = Arr.flatMap(Arr.range(1, 6), (item) =>
	Arr.map(tags, (tag) => ({ item, tag }))
)

export const caseGen: Gen<FactsCase> = (source) => {
	const stored = source.draw(itemsGen(storedIds))
	const deleted = source.draw(int(1, stored.length))
	return {
		stored,
		facts: {
			insert: { Label: source.draw(shuffled(labelFacts, { min: 1, max: 5 })) },
			put: { Item: source.draw(itemsGen(putIds)) },
			delete: { Item: Arr.take(stored, deleted) }
		}
	}
}

const memberGen: Gen<MemberKey> = element(["insert", "put", "delete"] as const)

export const plantGen: Gen<Plant> = (source) => {
	const kind = source.draw(element(["none", "emptied", "omitted", "swapped"] as const))
	return kind === "none" || kind === "swapped" ? { kind } : { kind, member: source.draw(memberGen) }
}

/** `facts` with the member `member`'s record replaced by `record`. */
const withMember = (facts: CallFacts, member: MemberKey, record: unknown): unknown => ({
	...facts,
	[member]: record
})

/** The record a planted handle passes for `facts`. */
export const plantedFacts = (facts: CallFacts, plant: Plant): unknown => {
	switch (plant.kind) {
		case "none":
			return facts
		case "emptied":
			return withMember(
				facts,
				plant.member,
				plant.member === "insert" ? { Label: [] } : { Item: [] }
			)
		case "omitted":
			return withMember(facts, plant.member, {})
		case "swapped":
			return { ...facts, put: facts.delete, delete: facts.put }
	}
}

export const featureOf = (plant: Plant): Feature => {
	switch (plant.kind) {
		case "none":
			return "no plant"
		case "emptied":
			return "a member's facts emptied"
		case "omitted":
			return "a member's facts omitted"
		case "swapped":
			return "the put's and delete's facts swapped"
	}
}

/** The items stored after `facts` apply over `stored`: those it deletes gone, those it puts added. */
export const itemsAfter = (
	stored: ReadonlyArray<ItemFact>,
	facts: CallFacts
): ReadonlyArray<ItemFact> => {
	const deleted = new Set(Arr.map(facts.delete.Item, (i) => i.id))
	return [...Arr.filter(stored, (i) => !deleted.has(i.id)), ...facts.put.Item]
}

/** Whether the rows `stored` are exactly the items `expected`, each once, in any order: no expected item repeats a key. */
export const sameItems = (
	stored: ReadonlyArray<unknown>,
	expected: ReadonlyArray<ItemFact>
): boolean =>
	stored.length === expected.length &&
	Arr.every(expected, (item) =>
		Arr.some(plainRows(stored), (row) => deepEquals<unknown>(row, item))
	)

/** Rows as plain records of their fields: a read delivers records of no prototype, which a fact literal is not. */
export const plainRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
	Arr.map(rows, (row) => (isRecord(row) ? { ...row } : row))
