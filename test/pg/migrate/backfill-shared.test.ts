/**
 * Two families over one member table, added to stored rows: the migration's backfill draws both families' columns of
 * the member table in one UPDATE, so each member row takes one new version, not one per family, on PostgreSQL 19rc2.
 *
 * A case draws one to three owners of each family, Owner by g and Other by h, and up to six members, each in one group
 * of each, keyed apart and written in a drawn order. The second version counts Member under Owner and again under
 * Other, each a counted family that draws its hidden index on Member and its count on its owner.
 *
 * Oracle: the drafted Structure file, as the runner applied it, holds exactly one UPDATE of Member's table, since
 * neither family's member backfill reads a column the other draws (deploy/diff/backfill.ts merged); each owner's drawn
 * count is the number of its members, counted here over the written rows; and VALIDATE, which judges every native of
 * both families over the backfilled rows, the hidden indexes among them, leaves no constraint NOT VALID.
 *
 * Features: an owner with no member, an owner of several members, members written out of their key order; each pending
 * one aimed at by a case constructed to reach it.
 *
 * Plant (~/.cache/grizzle-release/MIGBATCH/plants/backfill-one-update-per-part.patch): no member part joins its
 * table's UPDATE, so Member takes two.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { counted, fin, on, relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { PropertyFailed } from "#test/support/oracle/runner.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A member: its key, and its group under each family, Owner's g and Other's h, each an owner's id. */
interface Member {
	readonly member: number
	readonly g: number
	readonly h: number
}

interface SharedCase {
	readonly owners: number
	readonly others: number
	/** In the order written. */
	readonly members: ReadonlyArray<Member>
}

const maxOwners = 3
const maxMembers = 6

const before = (name: string) =>
	schema(
		name,
		[
			relation("Owner", { id: pg.int4 }, ["id"]),
			relation("Other", { id: pg.int4 }, ["id"]),
			relation("Member", { member: pg.int4, g: pg.int4, h: pg.int4 }, ["member"])
		],
		[]
	)

const after = (name: string) => {
	const Owner = relation("Owner", { id: pg.int4, n: drawnField(natural) }, ["id"])
	const Other = relation("Other", { id: pg.int4, m: drawnField(natural) }, ["id"])
	const Member = relation("Member", { member: pg.int4, g: pg.int4, h: pg.int4 }, ["member"])
	return schema(
		name,
		[Owner, Other, Member],
		[counted(on(Member, "g"), fin(Owner, "n")), counted(on(Member, "h"), fin(Other, "m"))]
	)
}

/** Members keyed apart, written in the order drawn, each in a drawn group of each family. */
const membersOf =
	(owners: number, others: number, keys: Gen<ReadonlyArray<number>>): Gen<ReadonlyArray<Member>> =>
	(s) =>
		Arr.map(s.draw(keys), (member) => ({
			member,
			g: s.draw(int(1, owners)),
			h: s.draw(int(1, others))
		}))

const anyKeys = shuffled(Arr.range(1, 20), { min: 0, max: maxMembers })

const caseOf =
	(keys: Gen<ReadonlyArray<number>>): Gen<SharedCase> =>
	(s) => {
		const owners = s.draw(int(1, maxOwners))
		const others = s.draw(int(1, maxOwners))
		return { owners, others, members: s.draw(membersOf(owners, others, keys)) }
	}

const caseGen = caseOf(anyKeys)

type Feature =
	| "an owner with no member"
	| "an owner of several members"
	| "members written out of their key order"

const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"an owner with no member",
	"an owner of several members",
	"members written out of their key order"
]

/** Keys written from the highest down, at least two: out of their order. */
const descendingKeys: Gen<ReadonlyArray<number>> = (s) =>
	Arr.reverse(
		Arr.sort(s.draw(shuffled(Arr.range(1, 20), { min: 2, max: maxMembers })), Order.Number)
	)

/** Each owner's count of members, for owner ids 1 … owners, by the group each member is in. */
const sizesOf = (owners: number, groups: ReadonlyArray<number>): ReadonlyArray<number> =>
	Array.from({ length: owners }, (_, i) => Arr.filter(groups, (g) => g === i + 1).length)

/** Each owner's id and count as the read below spells them, sorted. */
const countsOf = (owners: number, groups: ReadonlyArray<number>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(sizesOf(owners, groups), (n, i) => `${i + 1} ${n}`),
		Order.String
	)

/** What a case reaches. */
const reached = (c: SharedCase): ReadonlyArray<Feature> => {
	const sizes = [
		...sizesOf(
			c.owners,
			Arr.map(c.members, (m) => m.g)
		),
		...sizesOf(
			c.others,
			Arr.map(c.members, (m) => m.h)
		)
	]
	const keys = Arr.map(c.members, (m) => m.member)
	return [
		...(Arr.some(sizes, (n) => n === 0) ? ["an owner with no member" as const] : []),
		...(Arr.some(sizes, (n) => n > 1) ? ["an owner of several members" as const] : []),
		...(Arr.some(keys, (k, i) => i > 0 && k < (keys[i - 1] ?? k))
			? ["members written out of their key order" as const]
			: [])
	]
}

/** The case run: the drawn one, or, while its steering leaves members out of their key order pending, one whose keys
 * are written from the highest down. */
const aimed = (c: SharedCase, notes: Case<Feature>): SharedCase =>
	Option.exists(notes.steering, (p) => p.names("members written out of their key order"))
		? notes.draw(caseOf(descendingKeys))
		: c

const namesOf = (declared: string) => {
	const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(declared))))
	return {
		table: (r: string) =>
			`${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r))))}`,
		column: (f: string) => quoteIdent(identifierOf(identity.column(parsedName(f))))
	}
}

const inserted = (owner: RawSession, declared: string, c: SharedCase): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { table, column } = namesOf(declared)
		const statements = [
			...Array.from(
				{ length: c.owners },
				(_, i) => `INSERT INTO ${table("Owner")} (${column("id")}) VALUES (${i + 1})`
			),
			...Array.from(
				{ length: c.others },
				(_, i) => `INSERT INTO ${table("Other")} (${column("id")}) VALUES (${i + 1})`
			),
			...Arr.map(
				c.members,
				(m) =>
					`INSERT INTO ${table("Member")} (${column("member")}, ${column("g")}, ${column("h")}) VALUES (${m.member}, ${m.g}, ${m.h})`
			)
		]
		yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
		for (const sql of statements) {
			yield* owner.query(sql, [])
		}
		yield* owner.query("COMMIT", [])
	}).pipe(Effect.orDie)

const failed = (report: string) => Effect.fail(new PropertyFailed({ report }))

const property = (drawnCase: SharedCase, notes: Case<Feature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const c = aimed(drawnCase, notes)
			for (const feature of reached(c)) {
				notes.note(feature)
			}
			const state = { declared: "" }
			const m = yield* migrated({
				label: "backfill_shared",
				schemaName: { kind: "unique" },
				first: (name) => {
					state.declared = name
					return { schema: before(name), logins: [] }
				},
				later: [(name) => ({ schema: after(name), logins: [] })],
				apply: { kind: "noPlaceholders" },
				declared: () => noDeclarations,
				observe: Option.some((version: number, owner: RawSession) =>
					version === 0 ? inserted(owner, state.declared, c) : Effect.void
				)
			})
			const { table, column } = namesOf(state.declared)
			const structure = Arr.flatMap(m.folders, (folder, at) =>
				at === 1 ? Arr.filter(folder.files, (f) => Str.endsWith("-structure.sql")(f.name)) : []
			)
			const memberUpdates = Arr.flatMap(structure, (f) =>
				Arr.filter(Str.split(f.text, "\n"), (line) =>
					Str.startsWith(`UPDATE ${table("Member")} AS`)(line)
				)
			)
			if (memberUpdates.length !== 1) {
				return yield* failed(
					`the backfill draws Member's columns of both families in ${memberUpdates.length} UPDATEs, where neither reads what the other draws, so one does: ${Formatter.format(c)}`
				)
			}
			const read = (relation: string, count: string) =>
				Effect.map(
					substrate.admin.queryValues(
						`SELECT ${column("id")}::text || ' ' || ${column(count)}::text FROM ${table(relation)}`,
						[]
					),
					(rows) =>
						Arr.sort(
							Arr.map(rows, (row) => String(Arr.getUnsafe(row, 0))),
							Order.String
						)
				)
			const owners: ReadonlyArray<string> = yield* read("Owner", "n")
			const others: ReadonlyArray<string> = yield* read("Other", "m")
			assert.deepEqual(
				owners,
				countsOf(
					c.owners,
					Arr.map(c.members, (mb) => mb.g)
				),
				"each Owner's count is its members'"
			)
			assert.deepEqual(
				others,
				countsOf(
					c.others,
					Arr.map(c.members, (mb) => mb.h)
				),
				"each Other's count is its members'"
			)
			const unvalidated = yield* substrate.admin.queryValues(
				`SELECT count(*)::int4 FROM pg_catalog.pg_constraint WHERE connamespace = '${quoteIdent(m.schema)}'::regnamespace AND NOT convalidated`,
				[]
			)
			assert.equal(
				Number(Arr.getUnsafe(Arr.getUnsafe(unvalidated, 0), 0)),
				0,
				"VALIDATE leaves no constraint NOT VALID"
			)
		})
	)

layer(Substrate.layer)("two families over one member table, backfilled", (it) => {
	it.effect(
		"draw both families' member columns in one UPDATE, each owner's count its members'",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "postgresql",
							name: "the applied Structure file's UPDATEs of the member table, each owner's drawn count against its members counted over the written rows, and VALIDATE of both families' natives"
						},
						suite: "pg/migrate/backfill-shared",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(features, { cases: 2 * features.length, sense: notesOnly }),
						kept: [],
						runs: 6,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: 2,
						caseHang
					},
					(c, notes) => property(c, notes)
				)
			)
	)
})
