/** What the properties of nested-facts.test.ts read: its spaces, models and helpers. */

import { array, boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record } from "effect"
import { accumulated, drawn as drawnField, natural, int8 } from "#compiler/public/fields.ts"
import {
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { dictionaryNameGenOtherThan } from "#test/support/kernel/dict.ts"
import { uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** Owner(id, n drawn, total accumulated): the owner of the ordered family of Item. */
export const Owner = relation(
	"Owner",
	{ id: Id, n: drawnField(natural), total: accumulated(int8, 0n) },
	["id"]
)

const Item = relation("Item", { owner: Id, at: drawnField(natural), x: int8 }, ["owner", "at"])

const items = ordered(on(Item, "owner", "at"), fin(Owner, "n"))

export const Sequenced = schema(
	"Sequenced",
	[Owner, Item],
	[
		items,
		fold(items, Monoid.sum, on(Item, "owner", "x"), on(Owner, "id", "total")),
		unit("Owner", { id: Id }),
		unit("Items", { owner: Id }),
		mutable(Owner),
		mutable(Item)
	]
)

/** Every field either relation declares: a foreign field is none of them. */
const headings: ReadonlySet<string> = new Set([
	...Record.keys(Owner.fields),
	...Record.keys(Item.fields)
])

/** A field a fact states that its relation lacks, and its value. */
interface Foreign {
	readonly name: string
	readonly value: number
}

/** What one fact states beyond its caller's fields: its drawn or accumulated field's value, and a foreign field. */
interface Beyond {
	readonly written: Option.Option<bigint>
	readonly foreign: Option.Option<Foreign>
}

/** One owner's addition: what it states beyond its caller's fields, and its nested members, each a value of x. */
interface OwnerFact {
	readonly beyond: Beyond
	readonly members: Arr.NonEmptyReadonlyArray<Readonly<{ x: bigint; beyond: Beyond }>>
}

/** A dictionary name neither relation declares, drawn from the dictionary with the headings cut out. */
const foreignName = dictionaryNameGenOtherThan(headings)

const foreignGen: Gen<Foreign> = (source) => ({
	name: source.draw(foreignName).declared,
	value: source.draw(int(-2, 2))
})

const beyondGen: Gen<Beyond> = (source) => ({
	written: source.draw(boolean) ? Option.some(BigInt(source.draw(int(0, 3)))) : Option.none(),
	foreign: source.draw(boolean) ? Option.some(source.draw(foreignGen)) : Option.none()
})

const memberGen: Gen<Readonly<{ x: bigint; beyond: Beyond }>> = (source) => ({
	x: BigInt(source.draw(int(-3, 3))),
	beyond: source.draw(beyondGen)
})

const ownerGen: Gen<OwnerFact> = (source) => ({
	beyond: source.draw(beyondGen),
	members: [source.draw(memberGen), ...source.draw(array(memberGen, { min: 0, max: 2 }))]
})

export const additionsGen: Gen<Arr.NonEmptyReadonlyArray<OwnerFact>> = (source) => [
	source.draw(ownerGen),
	...source.draw(array(ownerGen, { min: 0, max: 1 }))
]

/** A fact's own fields, then the field its relation lacks where it states one. */
const withForeign = (
	fields: Readonly<Record<string, unknown>>,
	foreign: Option.Option<Foreign>
): Readonly<Record<string, unknown>> =>
	Option.match(foreign, {
		onNone: () => fields,
		onSome: (f) => ({ ...fields, [f.name]: f.value })
	})

/** The additions as a JavaScript caller states them: each owner by its id, its members nested under its count. */
export const additionsOf = (owners: Arr.NonEmptyReadonlyArray<OwnerFact>) =>
	Arr.map(owners, (o, i) =>
		withForeign(
			{
				id: uuidOf(i + 1),
				...Option.match(o.beyond.written, { onNone: () => ({}), onSome: (total) => ({ total }) }),
				n: Arr.map(o.members, (m) =>
					withForeign(
						{
							x: m.x,
							...Option.match(m.beyond.written, { onNone: () => ({}), onSome: (at) => ({ at }) })
						},
						m.beyond.foreign
					)
				)
			},
			o.beyond.foreign
		)
	)

export const beyondAny = (b: Beyond): boolean =>
	Option.isSome(b.written) || Option.isSome(b.foreign)

export type NestedFeature =
	| "the owner states its accumulated end"
	| "a member states its drawn index"
	| "the owner states a field its relation lacks"
	| "a member states a field its relation lacks"
	| "only a later member states beyond its caller's fields"
	| "every fact states its caller's fields alone"

export const reality = realityWrite(succeeded(testArtifacts(Sequenced, testCompile)))
