/** What the properties of nested-identity.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, constant } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn as drawnField, natural } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { Id } from "#test/support/ids.ts"

/**
 * A nested write whose texts sum past the longest string V8 holds (maxStringLength) is accepted by
 * PostgreSQL and reads back as written, on PostgreSQL 19rc2: its identities are structural (write/family/nesting.ts
 * NestedSet), so the host never joins its rows' texts into one, where it once died with `RangeError: Invalid string
 * length` before any SQL.
 *
 * The schema is the downstream case's: an owner whose ordered family of members each holds a body of a's, keyed by
 * their owner and slot. A case is one owner inserted with its members nested, each body a's to its drawn length; the
 * downstream case, seven bodies of 80,000,000 units, is kept, run once, and the drawn cases stay small.
 *
 * The oracle is PostgreSQL as the judge, and the round trip: every lawful write is accepted, adding the owner and each
 * member once, and reading the members back through the reader gives each body at its slot exactly as written, and the
 * owner's count its members'.
 *
 * Features: an owner with no members, members read back, members of two lengths, and the kept bodies past the longest
 * string.
 */
const Owner = relation("Owner", { id: Id, members: drawnField(natural) }, ["id"])

const Member = relation("Member", { at: drawnField(natural), body: str.regex("^a*$"), owner: Id }, [
	"owner",
	"at"
])

export const Bodies = schema(
	"NestedBodies",
	[Owner, Member],
	[ordered(on(Member, "owner", "at"), fin(Owner, "members"))]
)

/**
 * The full world's workload: an owner inserted with its members nested, each call's facts; and the members and the
 * owners read back.
 */
const programs = Object.freeze({
	insertOwner: ChangeSet.empty(Bodies).insert(Owner, []),
	members: query(Bodies).rule((r) => {
		const { owner, at, body } = v(Member, "member")
		return r.match(Member, { owner, at, body }).find({ owner, at, body })
	}),
	owners: query(Bodies).rule((r) => {
		const { id, members: count } = v(Owner, "owner")
		return r.match(Owner, { id, members: count }).find({ id, members: count })
	})
})

/** `n` a's: the empty text, or an a and the rest, as the body's pattern types its texts. */
export const aOf = (n: number): "" | `a${string}` => (n === 0 ? "" : `a${Str.repeat(n - 1)("a")}`)

/** A case: each member's body length, in slot order. */
interface BodiesCase {
	readonly lengths: ReadonlyArray<number>
}

export const caseGen: Gen<BodiesCase> = (source) => ({
	lengths: source.draw(array(element([0, 1, 2 ** 10, 2 ** 16] as const), { min: 0, max: 4 }))
})

/** The downstream case: seven bodies of 80,000,000 units, which sum past maxStringLength. */
const downstream: BodiesCase = { lengths: Arr.replicate(80_000_000, 7) }

export type BodiesFeature =
	| "an owner with no members"
	| "accepted and read back with members"
	| "members of two lengths"
	| "bodies summing past the longest string"

export const situations: Arr.NonEmptyReadonlyArray<BodiesFeature> = [
	"an owner with no members",
	"accepted and read back with members",
	"members of two lengths"
]

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const bodiesInstall = Object.freeze({ label: "nestedbodies", programs })

/** Bodies installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const bodiesTemplate = fixtureTemplate(import.meta, Bodies, bodiesInstall)

/**
 * The downstream case (72f7d0372, the host's identities once joined into one text past maxStringLength), which the
 * search kept and ran once: the drawn bodies stay small, so it alone reaches the bodies past the longest string, and is
 * that situation's aim, run while it is pending, once a run as the kept case was.
 */
const downstreamCases: ReadonlyArray<{
	readonly why: string
	readonly value: BodiesCase
	readonly reaches: ReadonlyArray<BodiesFeature>
}> = [
	{
		why: "downstream: one owner inserted with seven members nested, each body 80,000,000 a's, 560,000,000 units in all",
		value: downstream,
		reaches: ["bodies summing past the longest string"]
	}
]

/** The property's aims (downstream): each kept case's value at every situation it reaches. */
export const downstreamAims: ReadonlyArray<readonly [Reached<BodiesFeature>, Gen<BodiesCase>]> =
	Arr.flatMap(downstreamCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
