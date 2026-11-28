/** What the properties of delta.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	option,
	shuffled,
	subarray
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { relationIdentity } from "#compiler/runtime/write/net.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import {
	type Fact,
	type FactsByTexts,
	factSetOf,
	type FactTexts,
	identityOrder
} from "#test/support/oracle/delta.ts"
import { codesOf, compiled, cs } from "#test/support/unit/write/changeset/fixtures.ts"
import { upTo } from "#test/support/up-to.ts"

/** The fact of a model id. */
const fact = (id: string): Fact => ({ id })

/** The facts each relation's states are drawn over. */
const universe = ["a", "b", "c", "d"] as const

/**
 * The relation names a ChangeSet writes, among them two whose UTF-16 order is not their code point order: U+FF61 is
 * below U+10000 by code point, above it by code unit.
 */
const relationNames = [
	StoredRelationName("a"),
	StoredRelationName("b"),
	StoredRelationName("\uFF61"),
	StoredRelationName("\u{10000}")
] as const

/** The members of one stratum that returned a fact it made present, or absent, in the order their rows came back. */
const addedBy = element([["insert"], ["put"], ["insert", "put"], ["put", "insert"]] as const)

const removedBy = element([
	["delete"],
	["displaced"],
	["delete", "displaced"],
	["displaced", "delete"]
] as const)

/** One step of a relation's sequence: the state after it, which members returned each fact of the universe, and
 * whether a fact it holds before and after it comes back removed and added again, identical, as a delete and a lagging
 * generated addition return it, or a family's counts a stratum moves away and back. */
interface Step {
	readonly after: ReadonlyArray<string>
	readonly added: ReadonlyArray<ReadonlyArray<"insert" | "put">>
	readonly removed: ReadonlyArray<ReadonlyArray<"delete" | "displaced">>
	readonly restored: ReadonlyArray<boolean>
}

const step: Gen<Step> = (source) => ({
	after: source.draw(subarray(universe)),
	added: source.draw(array(addedBy, { min: universe.length, max: universe.length })),
	removed: source.draw(array(removedBy, { min: universe.length, max: universe.length })),
	restored: source.draw(array(boolean, { min: universe.length, max: universe.length }))
})

/** A relation's sequence: its start, and per stratum a step, or nothing when the stratum does not change it. */
interface Sequence {
	readonly start: ReadonlyArray<string>
	readonly steps: ReadonlyArray<Option.Option<Step>>
}

/** Up to three written relations, a name repeated among them, over one to five strata. */
export const sequences: Gen<{
	readonly written: ReadonlyArray<StoredRelationName>
	readonly strata: number
	readonly relations: ReadonlyArray<Sequence>
}> = (source) => {
	const written = source.draw(array(element(relationNames), { min: 1, max: 3 }))
	const strata = source.draw(int(1, 5))
	const distinct = [...new Set(written)]
	return {
		written,
		strata,
		relations: Arr.map(distinct, () => ({
			start: source.draw(subarray(universe)),
			steps: upTo(strata, () => source.draw(option(step)))
		}))
	}
}

/** The universe's facts a step returns removed and added back identical: those it holds before and after. */
export const restoredOf = (
	st: Step,
	before: FactsByTexts,
	after: FactsByTexts
): ReadonlyArray<FactTexts> =>
	Arr.filter([...before.keys()], (id) => after.has(id) && tagsOf(st.restored, id))

/** The model's facts of `ids`, each identified by its one text `[id]`. */
export const setOf = (ids: ReadonlyArray<string>): FactsByTexts =>
	factSetOf(Arr.map(ids, (id) => [[id], fact(id)] as const))

/** The model's id of an identity, which the model writes as the one text `[id]`. */
const modelId = (identity: FactTexts): string => defined(identity[0], "a model fact's one text")

/** A fact set's or a change's identities, in canonical order. */
export const identitiesOf = (keys: Iterable<FactTexts>): ReadonlyArray<FactTexts> =>
	Arr.sort(keys, identityOrder)

/** A change's entries, by identity in canonical order. */
export const entriesOf = <V>(
	entries: Iterable<readonly [FactTexts, V]>
): ReadonlyArray<readonly [FactTexts, V]> =>
	Arr.sort(
		entries,
		Order.mapInput(identityOrder, ([identity]: readonly [FactTexts, V]) => identity)
	)

/** What a step says of a fact of the universe: one entry per fact, by position. */
export const tagsOf = <T>(tags: ReadonlyArray<T>, identity: FactTexts): T => {
	const id = modelId(identity)
	return defined(
		Option.getOrUndefined(
			Option.flatMap(
				Arr.findFirstIndex(universe, (u) => u === id),
				(at) => Option.fromUndefinedOr(tags[at])
			)
		),
		`the tags of ${id}`
	)
}

/** Code point order, by the code points themselves. */
export const byCodePoints: Order.Order<string> = Order.mapInput(
	Order.Array(Order.Number),
	(text: string) =>
		Arr.map(Arr.fromIterable(text), (c) =>
			defined(Option.getOrUndefined(Str.codePointAt(0)(c)), "a code point")
		)
)

export type NettingFeature =
	| "a fact two members of a stratum made present"
	| "a fact two members of a stratum made absent"
	| "a fact a stratum removed and added back identical"
	| "a fact restored identical while an earlier stratum's change of it stands"
	| "a fact a later stratum's change cancels"
	| "a written relation no stratum changed"
	| "a repeated written relation"
	| "names out of code unit order"

/** Every item, in a drawn order. */
export const shuffledAll = <A>(items: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	shuffled(items, { min: items.length, max: items.length })

/** Work's TaskNote relation, as its compiled schema holds it. */
const note = defined(compiled(Work, cs(Work)).schema.relations.get("TaskNote"), "TaskNote")

/** Work's codes. */
const codes = codesOf(Work)

/** A TaskNote fact's identity, as the runtime keys it. */
export const id = relationIdentity(note.heading, codes)

/** TaskNote's fields with their specs, as the boundary's fact identity reads them. */
export const fields = Arr.map(note.heading, (c) => ({
	name: c.name,
	spec: scalarCodec(c.type, codes).spec
}))
