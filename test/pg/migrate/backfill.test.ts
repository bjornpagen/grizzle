/**
 * Adding a counted family with a fold to populated relations, on PostgreSQL 19rc1 (rows-first §6): A4's backfill data
 * step draws every member's hidden index, ‹i› = row_number() OVER (PARTITION BY g ORDER BY its key) − 1, its copy of the
 * count, and each fold plane's before and after as running sums in ‹i› order, and the owner's count and end; VALIDATE
 * then proves every native over the backfilled rows.
 *
 * - **A second implementation:** the reference fold (test/support/families/fold.ts) of each owner's members in key
 *   order states every backfilled value; what the migration leaves must be exactly that.
 * - **PostgreSQL as the judge:** the migration commits, and no constraint of the installation is left NOT VALID.
 *
 * The box: owners with 0, 1 and 3 existing members, so the backfill meets an empty family, a family of one (its first
 * slot its last), and a family whose predecessor chain the running sum must close.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Order } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import { counted, fin, fold, Monoid, on, relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { byMember, FOLD_SPECS, foldRead, foldSeatOf } from "#test/pg/fin/folds.ts"
import { seatOfInstalled } from "#test/pg/fin/installed.ts"
import { assert, defined } from "#test/support/assert.ts"
import { foldStoredOf } from "#test/support/families/fold.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The rows before the family: owner 0 with no member, owner 1 with one, owner 2 with three, members keyed apart. */
const EXISTING: ReadonlyArray<{
	readonly owner: number
	readonly members: ReadonlyArray<{ readonly member: number; readonly x: number }>
}> = [
	{ owner: 0, members: [] },
	{ owner: 1, members: [{ member: 10, x: 5 }] },
	{
		owner: 2,
		members: [
			{ member: 22, x: 1 },
			{ member: 20, x: 2 },
			{ member: 21, x: 3 }
		]
	}
] as const

const before = (name: string) =>
	schema(
		name,
		{
			Owner: relation("Owner", { id: pg.int4 }, ["id"]),
			Member: relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
		},
		[]
	)

const after = (name: string) => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) },
		["id"]
	)
	const Member = relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return schema(name, { Owner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end"))
	])
}

const SPEC = defined(
	Arr.findFirst(FOLD_SPECS, (s) => s.label === "sum of int4 over a counted family").pipe(
		Option.getOrUndefined
	)
)

/** Writes the existing rows, as the owner, in one SERIALIZABLE transaction, into the first version's tables. */
const written = (owner: RawSession, schemaName: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))
		const table = (r: string) =>
			`${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r))))}`
		const column = (f: string) => quoteIdent(identifierOf(identity.column(parsedName(f))))
		const owners = Arr.join(
			Arr.map(EXISTING, (o) => `(${o.owner})`),
			", "
		)
		const members = Arr.join(
			Arr.flatMap(EXISTING, (o) =>
				Arr.map(o.members, (mb) => `(${mb.member}, ${o.owner}, ${mb.x})`)
			),
			", "
		)
		yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
		yield* owner.query(`INSERT INTO ${table("Owner")} (${column("id")}) VALUES ${owners}`, [])
		yield* owner.query(
			`INSERT INTO ${table("Member")} (${column("member")}, ${column("g")}, ${column("x")}) VALUES ${members}`,
			[]
		)
		yield* owner.query("COMMIT", [])
	}).pipe(Effect.orDie)

layer(Substrate.layer)("backfilling a counted family with a fold on PostgreSQL 19rc1", (it) => {
	it.effect(
		"draw every hidden index, copy, accumulator, count and end of populated relations in key order, and VALIDATE every native",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				let schemaName = ""
				const m = yield* migrated({
					label: "backfill",
					schemaName: { kind: "unique" },
					first: (name) => {
						schemaName = name
						return { schema: before(name), logins: [] }
					},
					later: [(name) => ({ schema: after(name), logins: [] })],
					apply: { kind: "noPlaceholders" },
					register: false,
					declared: () => noDeclarations,
					observe: Option.some((v: number, owner: RawSession) =>
						v !== 0 ? Effect.void : written(owner, schemaName)
					)
				})
				const unvalidated = yield* s.admin.queryValues(
					`SELECT count(*)::int4 FROM pg_catalog.pg_constraint WHERE connamespace = '${quoteIdent(m.schema)}'::regnamespace AND NOT convalidated`,
					[]
				)
				assert.equal(
					Number(Arr.getUnsafe(Arr.getUnsafe(unvalidated, 0), 0)),
					0,
					"VALIDATE leaves no constraint NOT VALID"
				)
				const seat = yield* seatOfInstalled(m, ["Owner", "Member"], "backfill")
				const f = foldSeatOf({ ...SPEC, schema: after(m.declared) }, seat)
				const read = yield* foldRead(f)
				const expected = foldStoredOf(
					SPEC.monoid,
					Arr.map(EXISTING, (o) => ({
						owner: o.owner,
						members: Arr.map(
							Arr.sort(
								o.members,
								Order.mapInput(Order.Number, (mb: { readonly member: number }) => mb.member)
							),
							(mb: { readonly member: number; readonly x: number }) => ({
								member: mb.member,
								x: BigInt(mb.x),
								selected: true
							})
						)
					}))
				)
				assert.deepEqual(
					read,
					byMember(expected),
					"the backfill draws the reference fold of each family in key order"
				)
			})
	)
})
