/**
 * A family write's removals statement reads its stored tables by index, on PostgreSQL 19rc2 (write/family/removals.ts):
 * every stored row it reads, of a member relation it edits or refills and of an owner it recounts, is found at its
 * primary key from a keyset whose every arm is driven from the call's rows, its facts and the CTEs over them, joined to
 * stored rows by key or group. A condition over every stored row, an OR of EXISTS over the call's rows, plans as no
 * semi-join but a sequential scan: a whole-table read per call and a relation SIRead lock, which fails overlapping
 * SERIALIZABLE writers of the relation with 40001.
 *
 * - **PostgreSQL as the judge:** each served ChangeSet member is explained (its member's `explain`, one plan per
 *   statement its call sends) by the login's sessions, whose role plans with sequential, index and index-only scans
 *   disabled, over relations left unanalyzed (test/support/plans.ts unanalyzed), so no data size moves the verdict: a
 *   disabled node outranks every cost, and a sequential scan that survives is a read no index serves. No node of any
 *   plan reads a family's stored table by one: not an arm of a keyset, not the keyset's join, not the write.
 *
 * The box: each of the five shapes where the removals statement's arms meet, over every drawn instance of two to four
 * owners of each kind with two or three members each, at every owner:
 *
 * - a member deleted and another moved to the next owner by a put, in one stratum: the removed members' keyset of the
 *   deletes and the moving puts;
 * - two owners of one member relation's two families put, each changing a column the members copy and a fold steps:
 *   the refill's keyset of its two ways;
 * - an owner put that way and a member put in place, in one stratum: the edited and refilled members' keyset;
 * - an ordered member deleted: the deletion's keyset of the removed member and the members it re-places;
 * - a member of each of an owner's two counted families deleted: the recount's keyset of its two families' groups.
 *
 * Plant (~/.cache/grizzle-release/DENTRIAGE/plants/removals-or-exists.patch): removals.ts before the keysets, every site
 * an OR of EXISTS over its stored table: caught.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Layer } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { Plan } from "#adapter/types/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	contained,
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { installed } from "#test/pg/reads/support.ts"
import { caseHang } from "#test/support/limits.ts"
import { judgedSettings, unanalyzed } from "#test/support/plans.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

const Owner = relation(
	"Owner",
	{
		id: pg.int4,
		v: pg.int4,
		n: drawn(natural),
		n2: drawn(natural),
		e: accumulated(pg.int4, 0)
	},
	["id"]
)
const Other = relation(
	"Other",
	{ id: pg.int4, w: pg.int4, n: drawn(natural), e: accumulated(pg.int4, 0) },
	["id"]
)
const Member = relation(
	"Member",
	{
		member: pg.int4,
		g: pg.int4,
		h: pg.int4,
		x: pg.int4,
		c: accumulated(pg.int4, 0),
		d: accumulated(pg.int4, 0)
	},
	["member"]
)
const Second = relation("Second", { member: pg.int4, g: pg.int4 }, ["member"])
const Order = relation("Order", { id: pg.int4, n: drawn(natural) }, ["id"])
const Line = relation("Line", { line: pg.int4, order: pg.int4, at: drawn(natural) }, ["line"])

const byOwner = counted(on(Member, "g"), fin(Owner, "n"))
const byOther = counted(on(Member, "h"), fin(Other, "n"))
const seconds = counted(on(Second, "g"), fin(Owner, "n2"))
const lines = ordered(on(Line, "order", "at"), fin(Order, "n"))

/**
 * Two owners of Member's two counted families, each column a member copies along its family's owner axis stepped by
 * the family's sum, so a put of either owner that changes it refills its members; a second counted family of Owner's;
 * and an ordered family. Every relation mutable, so a put updates in place and a delete re-places a sequence.
 */
const Removals = schema(
	"removal_plans",
	[Owner, Other, Member, Second, Order, Line],
	[
		byOwner,
		byOther,
		seconds,
		lines,
		contained(on(Member, "g", "c"), on(Owner, "id", "v")),
		contained(on(Member, "h", "d"), on(Other, "id", "w")),
		fold(byOwner, Monoid.sum, on(Member, "g", "c"), on(Owner, "id", "e")),
		fold(byOther, Monoid.sum, on(Member, "h", "d"), on(Other, "id", "e")),
		mutable(Owner),
		mutable(Other),
		mutable(Member),
		mutable(Second),
		mutable(Order),
		mutable(Line)
	]
)

const RELATIONS: Arr.NonEmptyReadonlyArray<string> = [
	"Owner",
	"Other",
	"Member",
	"Second",
	"Order",
	"Line"
]

const programs = Object.freeze({
	loadOwners: ChangeSet.empty(Removals).insert(Owner, []).insert(Other, []).insert(Order, []),
	loadMembers: ChangeSet.empty(Removals).insert(Member, []).insert(Second, []),
	removeAndMove: ChangeSet.empty(Removals).delete(Member, []).put(Member, []),
	twoWays: ChangeSet.empty(Removals).put(Owner, []).put(Other, []),
	editAndRefill: ChangeSet.empty(Removals).put(Owner, []).put(Member, []),
	deleteLine: ChangeSet.empty(Removals).delete(Line, []),
	twoFamilies: ChangeSet.empty(Removals).delete(Member, []).delete(Second, [])
})

type Shape = "removed" | "two ways" | "edited and refilled" | "re-placed" | "recounted"

const SHAPES: Arr.NonEmptyReadonlyArray<Shape> = [
	"removed",
	"two ways",
	"edited and refilled",
	"re-placed",
	"recounted"
]

/**
 * A case: a shape, the instance it writes over, of `owners` owners of each kind holding `members` members of each
 * family, and the owner `at` its rows are drawn at, the next owner after it the one a move or a second way names.
 */
interface Sketch {
	readonly shape: Shape
	readonly owners: number
	readonly members: number
	readonly at: number
}

const sketchGen: Gen<Sketch> = (source) => {
	const owners = source.draw(int(2, 4))
	return {
		shape: source.draw(element(SHAPES)),
		owners,
		members: source.draw(int(2, 3)),
		at: source.draw(int(0, owners - 1))
	}
}

type Feature = `${Shape} read by index`

const readByIndex = (shape: Shape): Feature => `${shape} read by index`

/** The relations a family statement reads stored rows of, by their declared names. */
const FAMILY_TABLES: ReadonlySet<string> = new Set(RELATIONS)

/** Every family table a node of `plan` reads by a sequential scan. */
const seqScans = (plan: Plan): ReadonlyArray<string> => [
	...(plan.node === "Seq Scan" && plan.on.kind === "relation" && FAMILY_TABLES.has(plan.on.relation)
		? [plan.on.relation]
		: []),
	...Arr.flatMap(plan.children, seqScans)
]

/** Member `i` of owner `owner` in the instance of `s`, as stored: its key, its two groups and its x. */
const memberOf = (s: Sketch, owner: number, i: number) => ({
	member: owner * s.members + i,
	g: owner,
	h: s.owners - 1 - owner,
	x: i
})

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

layer(Substrate.layer, { excludeTestServices: true })(
	"a family write's removals read their stored tables by index on PostgreSQL 19rc2",
	(it) => {
		it.effect(
			"plan every keyset arm, the keyset's join and the write with no sequential scan of a family table, at every drawn size",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const o = yield* installed(Removals, {}, { label: "removal_plans", programs })
						const seat = yield* seatOfInstalled(o.installed, RELATIONS, "removal_plans")
						const login = quoteIdent(o.installed.as(o.server).role)
						for (const setting of judgedSettings) {
							yield* substrate.superuser(
								`ALTER ROLE ${login} IN DATABASE ${quoteIdent(substrate.database)} SET ${setting.parameter} = ${setting.value}`
							)
						}
						yield* unanalyzed(
							substrate.admin,
							Arr.map(RELATIONS, (r) => o.installed.names.relation(r))
						)
						const body = Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							/** The instance of `s` over emptied tables: its owners of each kind, each with its members of each family. */
							const loaded = (s: Sketch) =>
								Effect.gen(function* () {
									yield* cleared(seat, RELATIONS)
									const owners = upTo(s.owners, (id) => id)
									const indexes = upTo(s.members, (i) => i)
									yield* db.workload.loadOwners.once({
										params: {},
										facts: {
											insert: {
												Owner: Arr.map(owners, (id) => ({ id, v: 1 })),
												Other: Arr.map(owners, (id) => ({ id, w: 1 })),
												Order: Arr.map(owners, (id) => ({
													id,
													n: Arr.map(indexes, (i) => ({ line: id * s.members + i }))
												}))
											}
										}
									})
									yield* db.workload.loadMembers.once({
										params: {},
										facts: {
											insert: {
												Member: Arr.flatMap(owners, (id) =>
													Arr.map(indexes, (i) => memberOf(s, id, i))
												),
												Second: Arr.flatMap(owners, (id) =>
													Arr.map(indexes, (i) => ({ member: id * s.members + i, g: id }))
												)
											}
										}
									})
								})
							const plansOf = (s: Sketch) => {
								const next = (s.at + 1) % s.owners
								switch (s.shape) {
									case "removed":
										return db.workload.removeAndMove.explain({
											params: {},
											facts: {
												delete: { Member: [memberOf(s, s.at, 0)] },
												put: { Member: [{ ...memberOf(s, s.at, 1), g: next }] }
											}
										})
									case "two ways":
										return db.workload.twoWays.explain({
											params: {},
											facts: {
												put: { Owner: [{ id: s.at, v: 2 }], Other: [{ id: next, w: 2 }] }
											}
										})
									case "edited and refilled":
										return db.workload.editAndRefill.explain({
											params: {},
											facts: {
												put: {
													Owner: [{ id: s.at, v: 2 }],
													Member: [{ ...memberOf(s, next, 0), x: 7 }]
												}
											}
										})
									case "re-placed":
										return db.workload.deleteLine.explain({
											params: {},
											facts: { delete: { Line: [{ line: s.at * s.members, order: s.at }] } }
										})
									case "recounted":
										return db.workload.twoFamilies.explain({
											params: {},
											facts: {
												delete: {
													Member: [memberOf(s, s.at, 0)],
													Second: [{ member: s.at * s.members + 1, g: s.at }]
												}
											}
										})
								}
							}
							return yield* exhaust(
								{
									suite: "fin/removal-plans",
									generator: sketchGen,
									literal: Formatter.format,
									box: "each of the five shapes where the removals statement's arms meet, over two to four owners of each kind with two or three members of each family, at every owner",
									oracle: {
										kind: "postgresql",
										name: "EXPLAIN of each statement the member sends, sequential, index and index-only scans disabled over unanalyzed relations: no sequential scan of a family table"
									},
									coverage: requiredInSpace<Feature>(Arr.map(SHAPES, readByIndex)),
									caseHang,
									concurrency: 1
								},
								(s, c) =>
									Effect.gen(function* () {
										yield* loaded(s)
										const plans = yield* plansOf(s)
										const scans = Arr.flatMap(plans, (p) =>
											Arr.map(seqScans(p.plan), (relation) => `${p.statement}: ${relation}`)
										)
										if (scans.length > 0) {
											return yield* new Disagreed({
												message: `${s.shape} reads by a sequential scan: ${Arr.join(scans, "; ")}: ${Formatter.format(s)}`
											})
										}
										c.note(readByIndex(s.shape))
									})
							)
						})
						return yield* Effect.flatMap(Layer.build(o.served.layer), (context) =>
							Effect.provideContext(body, context)
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
