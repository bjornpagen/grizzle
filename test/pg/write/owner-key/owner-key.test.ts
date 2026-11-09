import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { compiledOpen } from "#adapter/db/open.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, counted, fin, fold, Monoid, on, relation, schema } from "#compiler/public/schema.ts"
import type { KeyHost } from "#compiler/types/changeset/changeset.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, containsEqual, unorderedEqual } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

/** Inserts into a family owner's primary key through db.apply, as a property against a host model of the key.
 *
 * An owner's row carries its family's count and its fold's end, which grizzle draws, so its insert proposes only the
 * requested facts no stored row holds the key of: PostgreSQL judges a proposed row by every CHECK before the arbiter
 * meets its key, and a stored owner proposed again would carry its count and end at their starts, which its row check
 * (here `end = cap`, as an invoice's lines sum to its amount) refuses wherever its members sum to more than nothing. A
 * stored owner at a requested key is judged as the key's arbiter would judge it: one whose payload equals the requested
 * fact's is the exact repeat, which changes nothing, members and all; one whose payload differs is a conflict, refused
 * by the owner's key law with that key as the witness.
 *
 * Each case draws a lawful stored state, owners at keys 0..3 each with zero to two members stated with it and a payload
 * its members sum to, and a ChangeSet of one to three requested owners (fresh, its family empty and its payload 0, an
 * exact repeat of a stored owner, or a stored key at another payload, the last two planted from the state), enumerated
 * or described over a relation parameter. The model gives the outcome: two requested owners at one key with different
 * payloads refuse with the key law and that key as the witness (before any SQL when enumerated, where it takes
 * precedence; a described member's statement may report the stored conflict beside it first); failing that, a requested
 * owner at a stored key with another payload refuses the same way; otherwise the stored state gains each requested
 * owner at a key no row holds, its family empty, accepted with those owners counted as added, or no-change when there
 * are none. A refusal leaves the stored state as it was, and no outcome touches a stored member. */
const Owner = relation(
	"Owner",
	{ id: pg.int4, cap: pg.int4, n: drawnField(natural), end: accumulated(pg.int4, 0) },
	["id"]
)
const Member = relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
const family = counted(on(Member, "g"), fin(Owner, "n"))
const Owners = schema("OwnerKeys", { Owner, Member }, [
	family,
	fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end")),
	check("Balanced", Owner, (o) => o.eq(o.end, o.cap))
])

/** A stored owner as the model holds it: its key, its payload, which its members sum to, and their step values. */
interface StoredOwner {
	readonly id: number
	readonly cap: number
	readonly members: ReadonlyArray<number>
}

/** A requested owner: its key and its payload. */
interface Requested {
	readonly id: number
	readonly cap: number
}

type Mode = "fresh" | "repeat" | "other payload"
type Form = "enumerated" | "described"

interface OwnerSketch {
	readonly id: number
	readonly members: ReadonlyArray<number>
}

interface RequestSketch {
	readonly mode: Mode
	readonly pick: number
	readonly id: number
}

interface OwnerCase {
	readonly form: Form
	readonly stored: ReadonlyArray<OwnerSketch>
	readonly requested: ReadonlyArray<RequestSketch>
}

const ownerCaseGen: Gen<OwnerCase> = (source) => ({
	form: source.draw(element<Form>(["enumerated", "described"])),
	stored: source.draw(
		array(
			(owner) => ({
				id: owner.draw(int(0, 3)),
				members: owner.draw(array(int(1, 3), { min: 0, max: 2 }))
			}),
			{ min: 0, max: 3 }
		)
	),
	requested: source.draw(
		array(
			(request) => ({
				mode: request.draw(element<Mode>(["fresh", "repeat", "other payload"])),
				pick: request.draw(pickGen),
				id: request.draw(int(0, 3))
			}),
			{ min: 1, max: 3 }
		)
	)
})

/**
 * The stored state: the drawn owners, each kept when no owner kept before holds its key, so the state is lawful, its
 * payload the sum of its members, as the row check holds it.
 */
const storedOf = (sketches: ReadonlyArray<OwnerSketch>): ReadonlyArray<StoredOwner> => {
	const kept: Array<StoredOwner> = []
	for (const s of sketches) {
		if (!Arr.some(kept, (k) => k.id === s.id)) {
			kept.push({ ...s, cap: Arr.reduce(s.members, 0, (sum, x) => sum + x) })
		}
	}
	return kept
}

/**
 * A requested owner: fresh, its payload 0 as its empty family sums to, or planted from a stored owner the pick selects,
 * at its payload or one past it.
 */
const requestedOf = (stored: ReadonlyArray<StoredOwner>, s: RequestSketch): Requested => {
	const [first, ...rest] = stored
	if (s.mode === "fresh" || first === undefined) {
		return { id: s.id, cap: 0 }
	}
	const at = pickFrom([first, ...rest], s.pick)
	return { id: at.id, cap: s.mode === "repeat" ? at.cap : at.cap + 1 }
}

/** The requested owners as a set: identical owners are one. */
const unique = (requested: ReadonlyArray<Requested>): ReadonlyArray<Requested> =>
	Arr.filter(requested, (f, i) =>
		Option.contains(
			Arr.findFirstIndex(requested, (g) => g.id === f.id && g.cap === f.cap),
			i
		)
	)

/** The model's outcome (see the header): a refusal by the owner's key law with the keys it may name, or the owners a
 * write adds. */
type Expected =
	| {
			readonly kind: "refused"
			readonly within: boolean
			readonly witnesses: ReadonlyArray<number>
	  }
	| { readonly kind: "applied"; readonly added: ReadonlyArray<Requested> }

const expected = (
	form: Form,
	stored: ReadonlyArray<StoredOwner>,
	requested: ReadonlyArray<Requested>
): Expected => {
	const within = Arr.filter(requested, (f) =>
		Arr.some(requested, (g) => g.id === f.id && g.cap !== f.cap)
	)
	const across = Arr.filter(requested, (f) =>
		Arr.some(stored, (s) => s.id === f.id && s.cap !== f.cap)
	)
	if (within.length > 0) {
		return {
			kind: "refused",
			within: true,
			witnesses: Arr.map(form === "enumerated" ? within : [...within, ...across], (f) => f.id)
		}
	}
	if (across.length > 0) {
		return { kind: "refused", within: false, witnesses: Arr.map(across, (f) => f.id) }
	}
	return {
		kind: "applied",
		added: Arr.filter(requested, (f) => !Arr.some(stored, (s) => s.id === f.id))
	}
}

type OwnerFeature =
	| `insert ${Form}`
	| "a fresh owner added"
	| "a stored owner's exact repeat changed nothing"
	| "a stored owner with members repeated exactly"
	| "a stored owner at the other payload refused by the key law"
	| "a stored owner with members at the other payload refused"
	| "two requested owners at one key refused by the key law"

const situations: Arr.NonEmptyReadonlyArray<OwnerFeature> = [
	"insert enumerated",
	"insert described",
	"a fresh owner added",
	"a stored owner's exact repeat changed nothing",
	"a stored owner with members repeated exactly",
	"a stored owner at the other payload refused by the key law",
	"a stored owner with members at the other payload refused",
	"two requested owners at one key refused by the key law"
]

layer(Substrate.layer, { excludeTestServices: true })(
	"inserts into a family owner's primary key",
	(it) => {
		it.effect(
			"agree with the key's model on drawn stored owners and requested ones, an exact repeat changing nothing and a stored conflict refused by the key law",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(
							Owners,
							{},
							{ label: "ownerkey", extensions: [], programs: {} }
						)
						const s = yield* Substrate
						const names = namesOf(o.installed)
						const ownerRow = (owner: StoredOwner) => ({
							id: owner.id,
							cap: owner.cap,
							n: BigInt(owner.members.length),
							end: Arr.reduce(owner.members, 0, (sum, x) => sum + x)
						})
						/** Each stored owner's members, numbered across the state so every member key is its own. */
						const membersOf = (stored: ReadonlyArray<StoredOwner>) =>
							Arr.flatMap(stored, (owner, at) =>
								Arr.map(owner.members, (x, i) => ({ member: at * 2 + i, g: owner.id, x }))
							)
						return yield* Effect.gen(function* () {
							const db = yield* compiledOpen(o.server.roles.app, {})
							const empty = ChangeSet.empty(o.schema)
							const items = query(o.schema).rule((r) => {
								const given = r.relation("items", { id: Owner.fields.id, cap: Owner.fields.cap })
								const { id, cap } = v(Owner, "owner")
								return r.match(given, { id, cap }).find({ id, cap })
							})
							return yield* explore(
								{
									oracle: { kind: "unstated" },
									suite: "write/owner-key",
									draw: drawn(ownerCaseGen),
									literal: Formatter.format,
									coverage: required<OwnerFeature>(situations, { cases: 80, sense: notesOnly }),
									kept: [
										{
											note: "a8b31081: an owner inserted beside its counted member carries the member's count and end, which its check over the end judges at the insert",
											sketch: {
												form: "enumerated",
												stored: [{ id: 0, members: [1] }],
												requested: [{ mode: "fresh", pick: 0, id: 0 }]
											},
											draws: "",
											reaches: ["insert enumerated"]
										}
									],
									runs: 80,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								(c, cx) =>
									Effect.gen(function* () {
										const stored = storedOf(c.stored)
										const requested = unique(Arr.map(c.requested, (r) => requestedOf(stored, r)))
										const members = membersOf(stored)
										yield* replaceRows(s.admin, installationGroup(names), [])
										if (stored.length > 0) {
											const loaded = yield* db.apply(
												empty
													.insert(
														Owner,
														Arr.map(stored, (owner) => ({ id: owner.id, cap: owner.cap }))
													)
													.insert(Member, members),
												{}
											)
											assert.equal(loaded.kind, "accepted", "the stored state loads")
										}
										const facts = Arr.map(requested, (f) => ({ id: f.id, cap: f.cap }))
										const outcome =
											c.form === "enumerated"
												? yield* db.apply(empty.insert(Owner, facts), {})
												: yield* db.apply(empty.insert(Owner, items), { items: facts })
										const want = expected(c.form, stored, requested)
										cx.note(`insert ${c.form}`)
										const storedMembers = yield* tableState(o.installed, Member)
										unorderedEqual(
											storedMembers,
											members,
											"no insert of an owner touches a stored member"
										)
										const owners = yield* tableState(o.installed, Owner)
										if (want.kind === "refused") {
											if (outcome.kind !== "invariant-rejected") {
												return assert.fail(`a refusal by the owner's key law, not ${outcome.kind}`)
											}
											assert.deepEqual(outcome.refused.laws, [
												names.described(names.primaryKeyLaw(Owner))
											])
											const witness = outcome.witness
											if (witness.kind !== "key") {
												return assert.fail(`a witness key, not ${witness.kind}`)
											}
											assert.equal(witness.relation, "Owner")
											containsEqual(
												Arr.map(want.witnesses, (id): Readonly<Record<string, KeyHost>> => ({
													id
												})),
												witness.values,
												"the witness is a key the model refuses"
											)
											unorderedEqual(owners, Arr.map(stored, ownerRow), "a refusal writes nothing")
											if (want.within) {
												cx.note("two requested owners at one key refused by the key law")
												return
											}
											cx.note("a stored owner at the other payload refused by the key law")
											if (
												Arr.some(stored, (owner) =>
													Arr.some(
														requested,
														(f) =>
															f.id === owner.id && f.cap !== owner.cap && owner.members.length > 0
													)
												)
											) {
												cx.note("a stored owner with members at the other payload refused")
											}
											return
										}
										unorderedEqual(
											owners,
											[
												...Arr.map(stored, ownerRow),
												...Arr.map(want.added, (f) => ownerRow({ ...f, members: [] }))
											],
											"the stored owners and each requested one at a key no row held"
										)
										const repeats = Arr.filter(stored, (owner) =>
											Arr.some(requested, (f) => f.id === owner.id)
										)
										if (repeats.length > 0) {
											cx.note("a stored owner's exact repeat changed nothing")
										}
										if (Arr.some(repeats, (owner) => owner.members.length > 0)) {
											cx.note("a stored owner with members repeated exactly")
										}
										if (want.added.length === 0) {
											assert.equal(outcome.kind, "no-change")
											return
										}
										if (outcome.kind !== "accepted") {
											return assert.fail(`accepted, not ${outcome.kind}`)
										}
										assert.deepEqual(
											Arr.map(outcome.counts, (n) => ({ ...n })),
											[
												{
													relation: "Owner",
													added: BigInt(want.added.length),
													deleted: 0n,
													put: 0n
												}
											]
										)
										cx.note("a fresh owner added")
									})
							)
						}).pipe(
							(body) =>
								Effect.flatMap(Layer.build(loginLayer(o.installed, o.server)), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
