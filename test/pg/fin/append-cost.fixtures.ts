/** What the property of append-cost.test.ts reads: its schema, its box and the measure of one append. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { Fixture } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	installWrites,
	observedChange,
	openFull,
	type ProbeSession
} from "#bench/write/support/writes.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, int8 } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	mutable,
	on,
	ordered,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A sequence's owner, its count the slots of its lines. */
const Doc = relation("Doc", { id: int8, lines: drawn(natural) }, ["id"])

/** A sequence's member at its drawn slot, keyed apart from its place, so a put moves it to another doc's end. */
const Line = relation("Line", { id: int8, doc: int8, at: drawn(natural), payload: int8 }, ["id"])

/** A counted family's owner. */
const Group = relation("Group", { id: int8, size: drawn(natural) }, ["id"])

/** A counted family's member, a row of its own naming its group. */
const Tag = relation("Tag", { id: int8, grp: int8, payload: int8 }, ["id"])

/** The box's schema: a sequence and a counted family, each of a mutable owner, the sequence's lines mutable too. */
const build = (name: string) =>
	schema(
		name,
		[Doc, Line, Group, Tag],
		[
			ordered(on(Line, "doc", "at"), fin(Doc, "lines")),
			counted(on(Tag, "grp"), fin(Group, "size")),
			mutable(Doc),
			mutable(Line),
			mutable(Group),
			unit("Id", { id: int8 })
		]
	)

type Schema = ReturnType<typeof build>

/**
 * The family an append writes: a sequence's, its member a line another doc held, put at its new doc, which joins it
 * past the last (docs/schema.md "A change rewrites what it shifts"), since a sequence's members are inserted only nested under
 * an owner the write inserts; or a counted family's, its member inserted naming its stored owner.
 */
export const kinds = ["a sequence", "a counted family"] as const

export type Kind = (typeof kinds)[number]

/** The sizes of the stored family an append measures at, each tenfold the one before. */
export const sizes = [10, 100, 1000, 10000] as const

/** A case: the family the append writes. */
export interface Sketch {
	readonly kind: Kind
}

export const sketchGen: Gen<Sketch> = (source) => ({ kind: source.draw(element(kinds)) })

export type Feature = `an append to ${Kind}`

/** The owner and the member of a kind's family, by relation name. */
const tablesOf: Readonly<Record<Kind, { readonly owner: string; readonly member: string }>> = {
	"a sequence": { owner: "Doc", member: "Line" },
	"a counted family": { owner: "Group", member: "Tag" }
}

/** The ChangeSet storing owner 1 with its family of `n` members, and, for a sequence, doc 2 holding line `n`, the one the
 * append moves. */
const storedFamily = (s: Schema, kind: Kind, n: number) => {
	switch (kind) {
		case "a sequence":
			return ChangeSet.empty(s).insert(Doc, [
				{
					id: 1n,
					lines: Arr.map(indices(n), (k) => ({ id: BigInt(k), payload: BigInt(k) }))
				},
				{ id: 2n, lines: [{ id: BigInt(n), payload: BigInt(n) }] }
			])
		case "a counted family":
			return ChangeSet.empty(s)
				.insert(Group, [{ id: 1n }])
				.insert(
					Tag,
					Arr.map(indices(n), (k) => ({ id: BigInt(k), grp: 1n, payload: BigInt(k) }))
				)
	}
}

/** The ChangeSet appending one member to owner 1's stored family of `n`: line `n` put at doc 1, or tag `n` inserted. */
const appendOne = (s: Schema, kind: Kind, n: number) => {
	switch (kind) {
		case "a sequence":
			return ChangeSet.empty(s).put(Line, [{ id: BigInt(n), doc: 1n, payload: BigInt(n) }])
		case "a counted family":
			return ChangeSet.empty(s).insert(Tag, [{ id: BigInt(n), grp: 1n, payload: BigInt(n) }])
	}
}

/**
 * What one append cost: the pages it read of its family's tables and their indexes, the rows it read of them and the
 * rows it changed there; and the SQLSTATE PostgreSQL refused a dangling member with after it, a member written past the
 * family's last slot.
 */
export interface Cost {
	readonly n: number
	readonly pages: number
	readonly ownersUpdated: number
	readonly membersUpdated: number
	readonly membersInserted: number
	readonly rows: number
	readonly dangling: string
}

export const costText = (c: Cost): string =>
	`${c.pages} pages and ${c.rows} rows read at ${c.n} members (owner rows updated ${c.ownersUpdated}, member rows updated ${c.membersUpdated}, inserted ${c.membersInserted}; a dangling member ${c.dangling})`

/**
 * The pages a session's transaction has fetched so far of the tables `owner` and `member` and every index on them, shared
 * hits and reads alike (pg_stat_get_xact_blocks_fetched), the rows it updated and inserted in each, and the rows it read
 * of both, those its sequential scans returned and its index scans fetched (pg_stat_get_xact_tuples_returned, _fetched):
 * what the backend counts and has not yet reported, its own statements' and the RI queries its foreign keys run in it
 * alike.
 */
const readCost = (session: ProbeSession, owner: string, member: string) =>
	Effect.map(
		session.rows(
			"SELECT (SELECT COALESCE(pg_catalog.sum(pg_catalog.pg_stat_get_xact_blocks_fetched(c.oid)), 0) FROM pg_catalog.pg_class AS c WHERE c.oid IN ($1::pg_catalog.regclass, $2::pg_catalog.regclass) OR c.oid IN (SELECT i.indexrelid FROM pg_catalog.pg_index AS i WHERE i.indrelid IN ($1::pg_catalog.regclass, $2::pg_catalog.regclass)))::text, pg_catalog.pg_stat_get_xact_tuples_updated($1::pg_catalog.regclass)::text, pg_catalog.pg_stat_get_xact_tuples_updated($2::pg_catalog.regclass)::text, pg_catalog.pg_stat_get_xact_tuples_inserted($2::pg_catalog.regclass)::text, (pg_catalog.pg_stat_get_xact_tuples_returned($1::pg_catalog.regclass) + pg_catalog.pg_stat_get_xact_tuples_fetched($1::pg_catalog.regclass) + pg_catalog.pg_stat_get_xact_tuples_returned($2::pg_catalog.regclass) + pg_catalog.pg_stat_get_xact_tuples_fetched($2::pg_catalog.regclass))::text",
			[owner, member]
		),
		(rows) => {
			const [row] = rows
			const cell = (i: number): number => Number(row?.[i])
			return {
				pages: cell(0),
				ownersUpdated: cell(1),
				membersUpdated: cell(2),
				membersInserted: cell(3),
				rows: cell(4)
			}
		}
	)

/**
 * A direct writer's insert of a member past the last slot of owner 1's family of n + 1, as its owner: at slot n + 1,
 * naming itself its group's last, its successor its own slot, every other column as a member's; which the family's
 * natives refuse (the member at n names its own slot its successor, so the one at n + 1 has no predecessor that it
 * follows), at its statement for a sequence and at its COMMIT for a counted family.
 */
const danglingOf = (fx: Fixture<Schema>, kind: Kind, n: number): string => {
	const { member } = tablesOf[kind]
	const family = defined(
		Option.getOrUndefined(
			Arr.findFirst(fx.installed.installation.laws.families, (f) => f.member.name === member)
		),
		`the family of ${member}`
	)
	const slot = n + 1
	const next = quoteIdent(family.next)
	switch (kind) {
		case "a sequence":
			return `INSERT INTO ${fx.table(member)} (${fx.column(member, "id")}, ${fx.column(member, "doc")}, ${fx.column(member, "at")}, ${fx.column(member, "payload")}, ${next}) VALUES (${n + 1}, 1, ${slot}, 0, ${slot})`
		case "a counted family": {
			const index = family.shape.index
			if (index.kind !== "law") {
				throw new Error("a counted family's index is a law column")
			}
			return `INSERT INTO ${fx.table(member)} (${fx.column(member, "id")}, ${fx.column(member, "grp")}, ${fx.column(member, "payload")}, ${quoteIdent(index.column)}, ${next}) VALUES (${n + 1}, 1, 0, ${slot}, ${slot})`
		}
	}
}

/**
 * The cost of appending one member to a stored family of `n` of kind `kind`, on a fresh installation whose tables
 * autovacuum leaves alone: the family stored through one Db, then the append through a Db of its own, whose session
 * reads none of the family's tables before it, so every page counted is the append's. The append's deferred checks are
 * fired before its COMMIT (SET CONSTRAINTS ALL IMMEDIATE), so they are counted too.
 */
export const costOf = (kind: Kind, n: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("AppendCost"), "appendcost", {
				programs: {},
				logins: () => []
			})
			const S: Schema = build(fx.installed.declared)
			const substrate = yield* Substrate
			yield* Effect.forEach(
				fx.tables,
				(table) =>
					substrate.admin.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`, []),
				{ discard: true }
			)
			const stored = yield* Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFull(fx, S)
					const observed = yield* observedChange(db, storedFamily(S, kind, n), attemptLabel, {
						kind: "none"
					})
					return (yield* observed.apply({})).value.kind
				})
			)
			assert.equal(stored, "accepted", `${kind} of ${n} members is stored`)
			const { owner, member } = tablesOf[kind]
			const readings: Array<Omit<Cost, "n" | "dangling">> = []
			const appended = yield* Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFull(fx, S)
					const observed = yield* observedChange(db, appendOne(S, kind, n), attemptLabel, {
						kind: "probe",
						run: (session) =>
							Effect.gen(function* () {
								yield* session.rows("SET CONSTRAINTS ALL IMMEDIATE", [])
								const reading = yield* readCost(session, fx.table(owner), fx.table(member))
								readings.push(reading)
							})
					})
					return (yield* observed.apply({})).value
				})
			)
			assert.equal(
				appended.kind,
				"accepted",
				`the append to ${kind} of ${n} members: ${Formatter.format(appended)}`
			)
			const [reading, ...more] = readings
			assert.ok(
				reading !== undefined && more.length === 0,
				"the append is read once before its COMMIT"
			)
			const dangling = yield* Effect.match(substrate.admin.query(danglingOf(fx, kind, n), []), {
				onFailure: (e) =>
					e.reason._tag === "ServerError" ? e.reason.fields.code : "no server error",
				onSuccess: () => "committed"
			})
			return { n, ...reading, dangling } satisfies Cost
		})
	)
