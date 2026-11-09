import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, filter, type Gen, int, map } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { accumulated, drawn as drawnField, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { dictionaryNameGen } from "#test/support/kernel/dict.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { withinMessage } from "#test/support/worlds/execute/offline.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A nested addition's facts, as a JavaScript caller states them, hold the fields their caller writes at every depth, as
 * its type says (AdditionIn): a fact that states a field grizzle draws or accumulates, or one its relation lacks, is
 * refused before any SQL by its level's normalizer, an EncodingFailure of factShape. The split of an addition along its
 * families (write/changeset/value.ts encodeAddition) keeps every field a fact states but its count fields, where it
 * used to drop a drawn or accumulated field unsaid, its value lost.
 *
 * The schema: an owner of an ordered family with a sum fold, so the owner has an accumulated end and each member a
 * drawn index. A case draws one or two owners, each with one to three members nested, and each fact states, beside the
 * fields its caller writes, its drawn or accumulated field or not, and a field its relation lacks (a dictionary name
 * outside both headings) or not, each with a drawn value. The oracle is the type's contract: the insertion binds
 * exactly when no fact at any depth states a field beyond its caller's, and is refused as factShape otherwise.
 */
const Owner = relation(
	"Owner",
	{ id: uuid, n: drawnField(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Item = relation("Item", { owner: uuid, at: drawnField(natural), x: pg.bigint }, [
	"owner",
	"at"
])
const items = ordered(on(Item, "owner", "at"), fin(Owner, "n"))
const Sequenced = schema("Sequenced", { Owner, Item }, [
	items,
	fold(items, Monoid.sum, on(Item, "owner", "x"), on(Owner, "id", "total")),
	mutable(Owner),
	mutable(Item)
])

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

const foreignGen: Gen<Foreign> = (source) => ({
	name: source.draw(
		filter(
			map(dictionaryNameGen, (n) => n.declared),
			(name) => !headings.has(name),
			8
		)
	),
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

const additionsGen: Gen<Arr.NonEmptyReadonlyArray<OwnerFact>> = (source) => [
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
const additionsOf = (owners: Arr.NonEmptyReadonlyArray<OwnerFact>) =>
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

const beyondAny = (b: Beyond): boolean => Option.isSome(b.written) || Option.isSome(b.foreign)

type NestedFeature =
	| "the owner states its accumulated end"
	| "a member states its drawn index"
	| "the owner states a field its relation lacks"
	| "a member states a field its relation lacks"
	| "only a later member states beyond its caller's fields"
	| "every fact states its caller's fields alone"

describe("a nested addition's facts", () => {
	it.effect(
		"bind exactly when every fact states its caller's fields alone, refusing a drawn, accumulated or foreign field at any depth",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const reality = realityWrite(succeeded(testArtifacts(Sequenced, testCompile)))
					return yield* explore(
						{
							suite: "unit/write/nested-facts",
							draw: drawn(additionsGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "AdditionIn: a fact states the fields its caller writes, at every depth"
							},
							coverage: required<NestedFeature>(
								[
									"the owner states its accumulated end",
									"a member states its drawn index",
									"the owner states a field its relation lacks",
									"a member states a field its relation lacks",
									"only a later member states beyond its caller's fields",
									"every fact states its caller's fields alone"
								],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(owners, c) =>
							Effect.gen(function* () {
								const value = ChangeSet.empty(Sequenced).insert(Owner, additionsOf(owners))
								const program = succeeded(compileWrite(checking(Sequenced), descOf(value), reality))
								const members = yield* collectInputs(program.binding.groups, parsedOf(value).inputs)
								const bound = withinMessage(
									bindWrite(program, {
										members,
										params: {},
										transport: inForce(bindFrame)
									})
								)
								const memberFacts = Arr.flatMap(owners, (o) => o.members)
								if (Arr.some(owners, (o) => Option.isSome(o.beyond.written))) {
									c.note("the owner states its accumulated end")
								}
								if (Arr.some(memberFacts, (m) => Option.isSome(m.beyond.written))) {
									c.note("a member states its drawn index")
								}
								if (Arr.some(owners, (o) => Option.isSome(o.beyond.foreign))) {
									c.note("the owner states a field its relation lacks")
								}
								if (Arr.some(memberFacts, (m) => Option.isSome(m.beyond.foreign))) {
									c.note("a member states a field its relation lacks")
								}
								const owned = Arr.some(owners, (o) => beyondAny(o.beyond))
								const firsts = Arr.some(owners, (o) =>
									beyondAny(Arr.headNonEmpty(o.members).beyond)
								)
								const later = Arr.some(owners, (o) =>
									Arr.some(Arr.tailNonEmpty(o.members), (m) => beyondAny(m.beyond))
								)
								if (!owned && !firsts && later) {
									c.note("only a later member states beyond its caller's fields")
								}
								if (!owned && !firsts && !later) {
									c.note("every fact states its caller's fields alone")
									assertVariant(succeeded(bound), "kind", "bound", "the caller's fields bind")
									return
								}
								const failure = refused(
									bound,
									"factShape",
									"a fact holds the fields its caller writes, refused before any SQL"
								)
								assert.equal(failure._tag, "EncodingFailure", "the caller's input is refused")
							})
					)
				})
			)
	)
})
