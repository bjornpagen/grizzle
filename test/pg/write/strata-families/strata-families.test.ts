import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { compiledOpen } from "#adapter/db/open.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { counted, fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A ChangeSet writing a counted family's members in one stratum and nesting an ordered family's members under a new
 * owner in another, on PostgreSQL 19rc1: each stratum plans its own family edits only (write/program/bind.ts planned),
 * from the one read before the ChangeSet's writes, so the edits take effect once, in their stratum, whichever stratum
 * comes first, and beside the nested insert in one stratum too.
 *
 * The box: Club 0 with its counted members 1 and 2 stored, and a ChangeSet that deletes member 1 or inserts member 3,
 * and inserts Doc 1 with two lines nested, the edit's stratum before the insert's, after it, or the same.
 *
 * The oracle is the write restated: the edit's members, Club 0's count theirs, and Doc 1 with its two lines, at slots 0
 * and 1, every write accepted.
 */
const Club = relation("Club", { id: pg.int4, n: drawn(natural) }, ["id"])
const Member = relation("Member", { m: pg.int4, club: pg.int4 }, ["m"])
const Doc = relation("Doc", { id: uuid, lines: drawn(natural) }, ["id"])
const Line = relation("Line", { id: uuid, doc: uuid, at: drawn(natural), qty: pg.bigint }, ["id"])
const Strata = schema("StrataFamilies", { Club, Member, Doc, Line }, [
	counted(on(Member, "club"), fin(Club, "n")),
	ordered(on(Line, "doc", "at"), fin(Doc, "lines")),
	mutable(Club),
	mutable(Member),
	mutable(Doc)
])

type EditKind = "member 1 deleted" | "member 3 inserted"
type Placement = "the edit first" | "the nested insert first" | "one stratum"

/** The members after the edit. */
const membersAfter = (edit: EditKind): ReadonlyArray<number> =>
	edit === "member 1 deleted" ? [2] : [1, 2, 3]

const caseGen: Gen<readonly [EditKind, Placement]> = (source) =>
	[
		source.draw(element(["member 1 deleted", "member 3 inserted"] as const)),
		source.draw(element(["the edit first", "the nested insert first", "one stratum"] as const))
	] as const

layer(Substrate.layer, { excludeTestServices: true })(
	"family edits and a nested insert in two strata, on PostgreSQL 19rc1",
	(it) => {
		it.effect("take effect once each, in their own stratum, whichever comes first", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const o = yield* installed(Strata, {}, { label: "strata_families", extensions: [] })
					const group = installationGroup(namesOf(o.installed))
					return yield* Effect.gen(function* () {
						const db = yield* compiledOpen(o.server.roles.app, {})
						const members = query(o.schema).rule((r) => {
							const { m, club } = v(Member, "member")
							return r.match(Member, { m, club }).find({ m })
						})
						const clubs = query(o.schema).rule((r) => {
							const { id, n } = v(Club, "club")
							return r.match(Club, { id, n }).find({ id, n })
						})
						const lines = query(o.schema).rule((r) => {
							const { id, doc, at, qty } = v(Line, "line")
							return r.match(Line, { id, doc, at, qty }).find({ id, at })
						})
						const docs = query(o.schema).rule((r) => {
							const { id, lines: count } = v(Doc, "doc")
							return r.match(Doc, { id, lines: count }).find({ id, lines: count })
						})
						return yield* exhaust(
							{
								suite: "pg/write/strata-families",
								generator: caseGen,
								literal: Formatter.format,
								limit: 6,
								box: "Club 0 with members 1 and 2, member 1 deleted or member 3 inserted, beside Doc 1 inserted with two lines nested, the edit's stratum first, last or the insert's",
								oracle: { kind: "specification", name: "the write restated over the box" },
								coverage: requiredInSpace<Placement>([
									"the edit first",
									"the nested insert first",
									"one stratum"
								]),
								caseHang
							},
							([edit, placement], c) =>
								Effect.gen(function* () {
									yield* replaceRows(s.admin, group, [])
									const seeded = yield* db.apply(
										ChangeSet.empty(o.schema).insert(Club, [{ id: 0 }]),
										{}
									)
									assert.equal(seeded.kind, "accepted")
									const stored = yield* db.apply(
										ChangeSet.empty(o.schema).insert(Member, [
											{ m: 1, club: 0 },
											{ m: 2, club: 0 }
										]),
										{}
									)
									assert.equal(stored.kind, "accepted")
									const edited =
										edit === "member 1 deleted"
											? ChangeSet.empty(o.schema).delete(Member, [{ m: 1, club: 0 }])
											: ChangeSet.empty(o.schema).insert(Member, [{ m: 3, club: 0 }])
									const doc = [
										{
											id: uuidOf(1),
											lines: [
												{ id: uuidOf(2), qty: 1n },
												{ id: uuidOf(3), qty: 2n }
											]
										}
									]
									const nested = ChangeSet.empty(o.schema).insert(Doc, doc)
									const write =
										placement === "the edit first"
											? ChangeSet.sequence(edited, nested)
											: placement === "the nested insert first"
												? ChangeSet.sequence(nested, edited)
												: ChangeSet.union(edited, nested)
									const outcome = yield* db.apply(write, {})
									assert.equal(outcome.kind, "accepted", `${edit}, ${placement}`)
									const memberRows = yield* Effect.flatMap(
										db.execute(members, {}),
										(r) => r.collect
									)
									assert.deepEqual(
										Arr.sort(
											Arr.map(memberRows, (row) => row.m),
											Order.Number
										),
										[...membersAfter(edit)],
										"the edit's members"
									)
									const clubRows = yield* Effect.flatMap(db.execute(clubs, {}), (r) => r.collect)
									assert.deepEqual(
										Arr.map(clubRows, (row) => ({ id: row.id, n: row.n })),
										[{ id: 0, n: BigInt(membersAfter(edit).length) }],
										"Club 0's count"
									)
									const docRows = yield* Effect.flatMap(db.execute(docs, {}), (r) => r.collect)
									assert.deepEqual(
										Arr.map(docRows, (row) => ({ id: row.id, lines: row.lines })),
										[{ id: uuidOf(1), lines: 2n }],
										"Doc 1 and its count"
									)
									const lineRows = yield* Effect.flatMap(db.execute(lines, {}), (r) => r.collect)
									assert.deepEqual(
										Arr.sort(
											Arr.map(lineRows, (row) => `${row.id} ${String(row.at)}`),
											Order.String
										),
										[`${uuidOf(2)} 0`, `${uuidOf(3)} 1`],
										"Doc 1's lines at their slots"
									)
									c.note(placement)
								})
						)
					}).pipe(Effect.scoped, withLayer(o.layer))
				}).pipe(Effect.scoped)
			)
		)
	}
)
