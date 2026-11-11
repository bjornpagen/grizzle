/**
 * A ChangeSet editing a counted family's members in one stratum and nesting an ordered family's members under new owners
 * in another, or in the same one, on PostgreSQL 19rc1: each stratum plans its own family edits only
 * (write/program/bind.ts planned), from the one read before the ChangeSet's writes, so every edit takes effect once, in
 * its stratum, whichever stratum comes first.
 *
 * A case stores clubs 0 and 1 with counted members at drawn ids, each in a drawn club, written through a served member;
 * then applies one ChangeSet that deletes some stored members and inserts fresh ones, each in a drawn club, beside an
 * insert of up to two docs, each with up to three lines nested, the edit's stratum before the insert's, after it, or the
 * same.
 *
 * - Property: the write is accepted, or no-change where it changes nothing, and leaves exactly the model's state.
 * - Oracle: the write restated (README, "Writing a family"): the members are the stored ones less the deleted plus the
 *   inserted, as a set; each club's count is its members'; each doc's count is its lines'; and each line sits at the
 *   slot of its place among its doc's nested lines, in order.
 * - Features: each placement; a stored member deleted, a member inserted, both in one edit; a club emptied; a doc of no
 *   line.
 * - Plant: ~/.cache/grizzle-release/BR08/plants/strata-families-every-stratum-plans-every-edit.patch, every stratum
 *   planning the edits of every stratum, must turn the property red.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, increasing, int, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn as drawnField, natural, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { counted, fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

const Club = relation("Club", { id: pg.int4, n: drawnField(natural) }, ["id"])
const Member = relation("Member", { m: pg.int4, club: pg.int4 }, ["m"])
const Doc = relation("Doc", { id: uuid, lines: drawnField(natural) }, ["id"])
const Line = relation("Line", { id: uuid, doc: uuid, at: drawnField(natural), qty: pg.bigint }, [
	"id"
])
const Strata = schema("StrataFamilies", { Club, Member, Doc, Line }, [
	counted(on(Member, "club"), fin(Club, "n")),
	ordered(on(Line, "doc", "at"), fin(Doc, "lines")),
	mutable(Club),
	mutable(Member),
	mutable(Doc)
])

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

type Placement = "the edit first" | "the nested insert first" | "one stratum"

const placements: readonly [Placement, ...Array<Placement>] = [
	"the edit first",
	"the nested insert first",
	"one stratum"
]

/** The clubs every case stores. */
const clubs = [0, 1] as const

/** A counted member: its id and its club. */
interface MemberFact {
	readonly m: number
	readonly club: number
}

/** A doc inserted with its lines nested, in their order. */
interface DocFact {
	readonly id: Uuid
	readonly lines: ReadonlyArray<{ readonly id: Uuid; readonly qty: bigint }>
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

const caseGen: Gen<StrataCase> = (source) => {
	const stored = source.draw(membersAt(storedIds))
	return {
		stored,
		deleted: source.draw(subset(stored, { min: 0, max: stored.length })),
		inserted: source.draw(membersAt(freshIds)),
		docs: source.draw(docsGen),
		placement: source.draw(element(placements))
	}
}

type Feature =
	| Placement
	| "a stored member deleted"
	| "a member inserted"
	| "a deletion and an insertion in one edit"
	| "a club emptied"
	| "a doc of no line"

const sameMember = (a: MemberFact, b: MemberFact): boolean => a.m === b.m

layer(Substrate.layer, { excludeTestServices: true })(
	"family edits and a nested insert in two strata, on PostgreSQL 19rc1",
	(it) => {
		it.effect("take effect once each, in their own stratum, whichever comes first", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const o = yield* installed(
						Strata,
						{},
						{ label: "strata_families", extensions: [], programs }
					)
					const group = installationGroup(namesOf(o.installed))
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(o.served.login.roles.app, {})
						return yield* explore(
							{
								suite: "pg/write/strata-families",
								draw: drawn(caseGen),
								literal: Formatter.format,
								oracle: {
									kind: "specification",
									name: "the write restated: members less the deleted plus the inserted, each count its family's, each line at its nested place"
								},
								coverage: required<Feature>(
									[
										...placements,
										"a stored member deleted",
										"a member inserted",
										"a deletion and an insertion in one edit",
										"a club emptied",
										"a doc of no line"
									],
									{ cases: 48, sense: notesOnly }
								),
								kept: [],
								runs: 32,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 8,
								caseHang
							},
							(c, notes) =>
								Effect.gen(function* () {
									yield* replaceRows(s.admin, group, [])
									const seeded = yield* answered(
										db.workload.seed.once({
											params: {},
											facts: {
												insert: { Club: Arr.map(clubs, (id) => ({ id })), Member: c.stored }
											}
										})
									)
									assert.equal(seeded.kind, "accepted", "the clubs and their members are stored")
									const facts = {
										delete: { Member: c.deleted },
										insert: { Member: c.inserted, Doc: c.docs }
									}
									const outcome = yield* c.placement === "the edit first"
										? answered(db.workload.editFirst.once({ params: {}, facts: facts }))
										: c.placement === "the nested insert first"
											? answered(db.workload.nestedFirst.once({ params: {}, facts: facts }))
											: answered(db.workload.together.once({ params: {}, facts: facts }))
									const changes = c.deleted.length + c.inserted.length + c.docs.length
									assert.equal(
										outcome.kind,
										changes === 0 ? "unchanged" : "accepted",
										`${Formatter.format(c)}: the outcome`
									)
									const members = [
										...Arr.filter(c.stored, (m) => !Arr.some(c.deleted, (d) => sameMember(d, m))),
										...c.inserted
									]
									const memberRows = yield* rowsOf(
										db.workload.members.once({ params: {}, facts: {} })
									)
									const clubRows = yield* rowsOf(db.workload.clubs.once({ params: {}, facts: {} }))
									const docRows = yield* rowsOf(db.workload.docs.once({ params: {}, facts: {} }))
									const lineRows = yield* rowsOf(db.workload.lines.once({ params: {}, facts: {} }))
									unorderedEqual(
										Arr.map(memberRows, (row) => ({ m: row.m, club: row.club })),
										members
									)
									unorderedEqual(
										Arr.map(clubRows, (row) => ({ id: row.id, n: row.n })),
										Arr.map(clubs, (id) => ({
											id,
											n: BigInt(Arr.filter(members, (m) => m.club === id).length)
										}))
									)
									unorderedEqual(
										Arr.map(docRows, (row) => ({ id: row.id, lines: row.lines })),
										Arr.map(c.docs, (d) => ({ id: d.id, lines: BigInt(d.lines.length) }))
									)
									unorderedEqual(
										Arr.map(lineRows, (row) => ({
											id: row.id,
											doc: row.doc,
											at: row.at,
											qty: row.qty
										})),
										Arr.flatMap(c.docs, (d) =>
											Arr.map(d.lines, (line, at) => ({
												id: line.id,
												doc: d.id,
												at: BigInt(at),
												qty: line.qty
											}))
										)
									)
									notes.note(c.placement)
									if (c.deleted.length > 0) {
										notes.note("a stored member deleted")
									}
									if (c.inserted.length > 0) {
										notes.note("a member inserted")
									}
									if (c.deleted.length > 0 && c.inserted.length > 0) {
										notes.note("a deletion and an insertion in one edit")
									}
									if (
										Arr.some(
											clubs,
											(id) =>
												Arr.some(c.stored, (m) => m.club === id) &&
												!Arr.some(members, (m) => m.club === id)
										)
									) {
										notes.note("a club emptied")
									}
									if (Arr.some(c.docs, (d) => d.lines.length === 0)) {
										notes.note("a doc of no line")
									}
								})
						)
					}).pipe(Effect.scoped, withLayer(o.served.layer))
				}).pipe(Effect.scoped)
			)
		)
	}
)
