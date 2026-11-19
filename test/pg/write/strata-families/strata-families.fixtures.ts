/** What the properties of strata-families.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, increasing, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { counted, fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { Id, type IdValue } from "#test/support/ids.ts"
import { upTo } from "#test/support/up-to.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

const Club = relation("Club", { id: pg.integer, n: drawnField(natural) }, ["id"])

const Member = relation("Member", { m: pg.integer, club: pg.integer }, ["m"])

const Doc = relation("Doc", { id: Id, lines: drawnField(natural) }, ["id"])

const Line = relation("Line", { id: Id, doc: Id, at: drawnField(natural), qty: pg.bigint }, ["id"])

export const Strata = schema(
	"StrataFamilies",
	[Club, Member, Doc, Line],
	[
		counted(on(Member, "club"), fin(Club, "n")),
		ordered(on(Line, "doc", "at"), fin(Doc, "lines")),
		mutable(Club),
		mutable(Member),
		mutable(Doc)
	]
)

/** The edit's stratum: deletions and insertions of counted members, each call's facts. */
const edit = () => ChangeSet.empty(Strata).delete(Member, []).insert(Member, [])

/** The nested insert's stratum: docs with their lines nested, each call's facts. */
const nested = () => ChangeSet.empty(Strata).insert(Doc, [])

/**
 * The full world's workload: the clubs and their stored members, seeded; the edit beside the nested insert in each
 * placement; and the members, clubs, docs and lines read back.
 */
const programs = Object.freeze({
	seed: ChangeSet.sequence(
		ChangeSet.empty(Strata).insert(Club, []),
		ChangeSet.empty(Strata).insert(Member, [])
	),
	editFirst: ChangeSet.sequence(edit(), nested()),
	nestedFirst: ChangeSet.sequence(nested(), edit()),
	together: ChangeSet.union(edit(), nested()),
	members: query(Strata).rule((r) => {
		const { m, club } = v(Member, "member")
		return r.match(Member, { m, club }).find({ m, club })
	}),
	clubs: query(Strata).rule((r) => {
		const { id, n } = v(Club, "club")
		return r.match(Club, { id, n }).find({ id, n })
	}),
	docs: query(Strata).rule((r) => {
		const { id, lines: count } = v(Doc, "doc")
		return r.match(Doc, { id, lines: count }).find({ id, lines: count })
	}),
	lines: query(Strata).rule((r) => {
		const { id, doc, at, qty } = v(Line, "line")
		return r.match(Line, { id, doc, at, qty }).find({ id, doc, at, qty })
	})
})

/** What every case installs: Strata, its full world's workload holding the programs. */
export const strataInstall = { label: "strata_families", programs } as const

/**
 * Strata installed once per member (reads/support.ts fixtureTemplate), which each case's seat holds, its tables empty
 * before every case.
 */
export const strataTemplate = fixtureTemplate(import.meta, Strata, strataInstall)

type Placement = "the edit first" | "the nested insert first" | "one stratum"

export const placements: readonly [Placement, ...Array<Placement>] = [
	"the edit first",
	"the nested insert first",
	"one stratum"
]

/** The clubs every case stores. */
export const clubs = [0, 1] as const

/** A counted member: its id and its club. */
interface MemberFact {
	readonly m: number
	readonly club: number
}

/** A doc inserted with its lines nested, in their order. */
interface DocFact {
	readonly id: IdValue
	readonly lines: ReadonlyArray<{ readonly id: IdValue; readonly qty: bigint }>
}

interface StrataCase {
	readonly stored: ReadonlyArray<MemberFact>
	readonly deleted: ReadonlyArray<MemberFact>
	readonly inserted: ReadonlyArray<MemberFact>
	readonly docs: ReadonlyArray<DocFact>
	readonly placement: Placement
}

/** The ids a stored member takes, and the fresh ones an insertion takes, apart by construction. */
const storedIds = { lo: 1, hi: 4 } as const

const freshIds = { lo: 5, hi: 7 } as const

const membersAt =
	(ids: Readonly<{ lo: number; hi: number }>): Gen<ReadonlyArray<MemberFact>> =>
	(source) =>
		Arr.map(source.draw(increasing(ids.lo, ids.hi, { min: 0, max: ids.hi - ids.lo + 1 })), (m) => ({
			m,
			club: source.draw(element(clubs))
		}))

/**
 * Up to two docs, each with up to three lines: each doc's id its place, each line's the next past every doc's and every
 * line's before it, so every id is its own by construction.
 */
const docsGen: Gen<ReadonlyArray<DocFact>> = (source) => {
	const counts = source.draw(array(int(0, 3), { min: 0, max: 2 }))
	let next = counts.length
	return Arr.map(counts, (count, d) => ({
		id: uuidOf(d + 1),
		lines: upTo(count, () => {
			next += 1
			return { id: uuidOf(next), qty: BigInt(source.draw(int(-2, 9))) }
		})
	}))
}

export const caseGen: Gen<StrataCase> = (source) => {
	const stored = source.draw(membersAt(storedIds))
	return {
		stored,
		deleted: source.draw(subset(stored, { min: 0, max: stored.length })),
		inserted: source.draw(membersAt(freshIds)),
		docs: source.draw(docsGen),
		placement: source.draw(element(placements))
	}
}

export type Feature =
	| Placement
	| "a stored member deleted"
	| "a member inserted"
	| "a deletion and an insertion in one edit"
	| "a club emptied"
	| "a doc of no line"

export const sameMember = (a: MemberFact, b: MemberFact): boolean => a.m === b.m
