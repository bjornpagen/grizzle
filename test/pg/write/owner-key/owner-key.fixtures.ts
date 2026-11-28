/** What the properties of owner-key.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, counted, fin, fold, Monoid, on, relation, schema } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"

/** Inserts into a family owner's primary key through served ChangeSets, as a property against a host model of the key.
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
 * are none. A refusal leaves the stored state as it was, and no outcome touches a stored member.
 *
 * The oracle is a second implementation, the host model of the key above.
 */
export const Owner = relation(
	"Owner",
	{ id: pg.integer, cap: pg.integer, n: drawnField(natural), end: accumulated(pg.integer, 0) },
	["id"]
)

export const CountedMember = relation(
	"Member",
	{ member: pg.integer, g: pg.integer, x: pg.integer },
	["member"]
)

const family = counted(on(CountedMember, "g"), fin(Owner, "n"))

export const Owners = schema(
	"OwnerKeys",
	[Owner, CountedMember],
	[
		family,
		fold(family, Monoid.sum, on(CountedMember, "g", "x"), on(Owner, "id", "end")),
		check("Balanced", Owner, (o) => o.eq(o.end, o.cap))
	]
)

/**
 * The full world's workload: the stored state's load, owners and members inserted from each call's facts; the
 * requested owners' insert, enumerated from each call's facts; and the same insert described over the relation
 * parameter `items`.
 */
const programs = Object.freeze({
	load: ChangeSet.empty(Owners).insert(Owner, []).insert(CountedMember, []),
	insertEnumerated: ChangeSet.empty(Owners).insert(Owner, []),
	insertDescribed: ChangeSet.empty(Owners).insert(
		Owner,
		query(Owners).rule((r) => {
			const given = r.relation("items", { id: Owner.fields.id, cap: Owner.fields.cap })
			const { id, cap } = v(Owner, "owner")
			return r.match(given, { id, cap }).find({ id, cap })
		})
	)
})

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

export const ownerCaseGen: Gen<OwnerCase> = (source) => ({
	form: source.draw(element<Form>(["enumerated", "described"])),
	stored: Arr.map(source.draw(subset([0, 1, 2, 3], { min: 0, max: 3 })), (id) => ({
		id,
		members: source.draw(array(int(1, 3), { min: 0, max: 2 }))
	})),
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
 * The stored state: the drawn owners, at distinct keys by construction (ownerCaseGen draws their keys as a subset),
 * each with its payload the sum of its members, as the row check holds it.
 */
export const storedOf = (sketches: ReadonlyArray<OwnerSketch>): ReadonlyArray<StoredOwner> =>
	Arr.map(sketches, (s) => ({ ...s, cap: Arr.reduce(s.members, 0, (sum, x) => sum + x) }))

/**
 * A requested owner: fresh, its payload 0 as its empty family sums to, or planted from a stored owner the pick selects,
 * at its payload or one past it.
 */
export const requestedOf = (stored: ReadonlyArray<StoredOwner>, s: RequestSketch): Requested => {
	const [first, ...rest] = stored
	if (s.mode === "fresh" || first === undefined) {
		return { id: s.id, cap: 0 }
	}
	const at = pickFrom([first, ...rest], s.pick)
	return { id: at.id, cap: s.mode === "repeat" ? at.cap : at.cap + 1 }
}

/** The requested owners as a set: identical owners are one. */
export const unique = (requested: ReadonlyArray<Requested>): ReadonlyArray<Requested> =>
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

export const expected = (
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

export type OwnerFeature =
	| `insert ${Form}`
	| "a fresh owner added"
	| "a stored owner's exact repeat changed nothing"
	| "a stored owner with members repeated exactly"
	| "a stored owner at the other payload refused by the key law"
	| "a stored owner with members at the other payload refused"
	| "two requested owners at one key refused by the key law"

export const situations: Arr.NonEmptyReadonlyArray<OwnerFeature> = [
	"insert enumerated",
	"insert described",
	"a fresh owner added",
	"a stored owner's exact repeat changed nothing",
	"a stored owner with members repeated exactly",
	"a stored owner at the other payload refused by the key law",
	"a stored owner with members at the other payload refused",
	"two requested owners at one key refused by the key law"
]

export const ownerRow = (owner: StoredOwner) => ({
	id: owner.id,
	cap: owner.cap,
	n: BigInt(owner.members.length),
	end: Arr.reduce(owner.members, 0, (sum, x) => sum + x)
})

/** Each stored owner's members, numbered across the state so every member key is its own. */
export const membersOf = (stored: ReadonlyArray<StoredOwner>) =>
	Arr.flatMap(stored, (owner, at) =>
		Arr.map(owner.members, (x, i) => ({ member: at * 2 + i, g: owner.id, x }))
	)

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const ownersInstall = Object.freeze({ label: "ownerkey", programs })

/** Owners installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const ownersTemplate = fixtureTemplate(import.meta, Owners, ownersInstall)
