/** What the property of redefined-checks.test.ts reads: its space, the schema's three versions and the migration over
 * stored rows. */

import { assert } from "@bjornpagen/testing/assert"
import { constant, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import { check, counted, fin, fold, Monoid, on, relation, schema } from "#compiler/public/schema.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { Aim } from "#test/support/pg/migrate/support.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** The bound Bounded holds each owner's total to in the first folded version, and in the second. */
const firstBound = 10
const secondBound = 100

/** M's members, each of an owner `o`, with the amounts `x` and `y`. */
const membersOf = () =>
	relation("M", { member: pg.integer, o: pg.integer, x: pg.bigint, y: pg.bigint }, ["member"])

/** The plain version, its rows stored before any family: O's owners and M's members. */
const plainOf = (name: string) =>
	schema(name, [relation("O", { id: pg.integer }, ["id"]), membersOf()], [])

/**
 * A folded version: O's counted members M, each owner's `total` the sum of its members' `x` (the first) or `y` (the
 * second), which Bounded, a CHECK on O, holds to the version's bound. The second migration draws every `total` again
 * under Bounded defined otherwise.
 */
const foldedOf = (version: "first" | "second") => (name: string) => {
	const O = relation(
		"O",
		{ id: pg.integer, n: drawn(natural), total: accumulated(pg.bigint, 0n) },
		["id"]
	)
	const M = membersOf()
	const members = counted(on(M, "o"), fin(O, "n"))
	const bound = BigInt(version === "first" ? firstBound : secondBound)
	return schema(
		name,
		[O, M],
		[
			members,
			fold(members, Monoid.sum, on(M, "o", version === "first" ? "x" : "y"), on(O, "id", "total")),
			check("Bounded", O, (o) => o.le(o.total, bound))
		]
	)
}

/** A member as stored: its amounts. */
interface Member {
	readonly x: number
	readonly y: number
}

/** The stored owners, ids 0 up, each with its members, keyed 0 up in owner order. */
export interface Stored {
	readonly owners: ReadonlyArray<ReadonlyArray<Member>>
}

/** Each owner's sum of its members' `amount`. */
const sumOf = (members: ReadonlyArray<Member>, amount: (m: Member) => number): number =>
	Arr.reduce(members, 0, (sum, m) => sum + amount(m))

export type Feature =
	| "an owner the second fold takes past the first CHECK"
	| "an owner the second fold keeps within the first CHECK"
	| "an owner of no members"

/** What a stored case reaches, owner by owner. */
export const featuresOf = (stored: Stored): ReadonlyArray<Feature> =>
	Arr.map(stored.owners, (members): Feature => {
		if (!Arr.isReadonlyArrayNonEmpty(members)) {
			return "an owner of no members"
		}
		return sumOf(members, (m) => m.y) > firstBound
			? "an owner the second fold takes past the first CHECK"
			: "an owner the second fold keeps within the first CHECK"
	})

/** An owner's members: as many as `count` draws, each `x` small enough that no owner's sum of them passes the first
 * bound, each `y` as `y` draws, small enough that no owner's sum passes the second. */
const ownerOf =
	(count: Gen<number>, y: Gen<number>): Gen<ReadonlyArray<Member>> =>
	(source) =>
		upTo(source.draw(count), () => ({ x: source.draw(int(0, 3)), y: source.draw(y) }))

const anyCount = int(0, 3)
const anyY = int(0, 33)

/** A leading owner as `lead` draws it, then up to two more owners of any members. */
const storedOf =
	(lead: Gen<ReadonlyArray<Member>>): Gen<Stored> =>
	(source) => ({
		owners: [
			source.draw(lead),
			...upTo(source.draw(int(0, 2)), () => source.draw(ownerOf(anyCount, anyY)))
		]
	})

/** One to three owners, each of up to three members, any amounts. */
export const storedGen: Gen<Stored> = storedOf(ownerOf(anyCount, anyY))

/** The stored rows each required situation is aimed at while it is pending: the generator draws the one a case's turn
 * aims at (aimed) in place of its plain draw. */
export const aims: ReadonlyArray<Aim<Stored, Feature>> = [
	[
		"an owner the second fold takes past the first CHECK",
		storedOf(ownerOf(int(1, 3), int(firstBound + 1, 33)))
	],
	[
		"an owner the second fold keeps within the first CHECK",
		storedOf(ownerOf(int(1, 3), int(0, 3)))
	],
	["an owner of no members", storedOf(ownerOf(constant(0), anyY))]
]

/** The installed identifiers of a schema's relations and fields. */
const namesOf = (schemaName: string) => {
	const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))
	return {
		table: (r: string) =>
			`${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r))))}`,
		column: (f: string) => quoteIdent(identifierOf(identity.column(parsedName(f))))
	}
}

/** Writes the stored owners and members into the plain version's tables, as the owner, in one transaction. */
const inserted = (owner: RawSession, schemaName: string, stored: Stored) =>
	Effect.gen(function* () {
		const { table, column } = namesOf(schemaName)
		const members = Arr.flatMap(stored.owners, (of, o) => Arr.map(of, (m) => ({ o, ...m })))
		yield* owner.query("BEGIN", [])
		yield* owner.query(
			`INSERT INTO ${table("O")} (${column("id")}) VALUES ${Arr.join(
				Arr.map(stored.owners, (_, o) => `(${o})`),
				", "
			)}`,
			[]
		)
		if (Arr.isArrayNonEmpty(members)) {
			yield* owner.query(
				`INSERT INTO ${table("M")} (${Arr.join(
					Arr.map(["member", "o", "x", "y"], column),
					", "
				)}) VALUES ${Arr.join(
					Arr.map(members, (m, k) => `(${k}, ${m.o}, ${m.x}, ${m.y})`),
					", "
				)}`,
				[]
			)
		}
		yield* owner.query("COMMIT", [])
	})

/**
 * The installation migrated from the plain version, over the stored rows written into it, to the first folded version
 * and then to the second, each folder drafted from the snapshot before and applied by the real runner; then each
 * owner's count and total as the last migration left them, and no constraint of it left NOT VALID.
 */
export const migratedOver = (stored: Stored) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		let schemaName = ""
		const m = yield* migrated({
			label: "redefined",
			schemaName: { kind: "unique" },
			first: (name) => {
				schemaName = name
				return { schema: plainOf(name), logins: [] }
			},
			later: [
				(name) => ({ schema: foldedOf("first")(name), logins: [] }),
				(name) => ({ schema: foldedOf("second")(name), logins: [] })
			],
			apply: { kind: "noPlaceholders" },
			declared: () => noDeclarations,
			observe: Option.some((version: number, owner: RawSession) =>
				version === 0 ? inserted(owner, schemaName, stored) : Effect.void
			)
		})
		const { table, column } = namesOf(m.declared)
		const read = yield* s.admin.queryValues(
			`SELECT ${Arr.join(
				Arr.map(["id", "n", "total"], (f) => `${column(f)}::text`),
				", "
			)} FROM ${table("O")}`,
			[]
		)
		const unvalidated = yield* s.admin.queryValues(
			`SELECT count(*)::int4 FROM pg_catalog.pg_constraint WHERE connamespace = '${quoteIdent(m.schema)}'::regnamespace AND NOT convalidated`,
			[]
		)
		assert.deepEqual(Arr.flatten(unvalidated), [0], "VALIDATE leaves no constraint NOT VALID")
		const owners: ReadonlyArray<string> = Arr.sort(
			Arr.map(read, (row) => Arr.join(Arr.map(row, String), " ")),
			Order.String
		)
		return owners
	})

/** Each owner's count of members and sum of their `y`, as the second folded version holds them, by the stored rows. */
export const expectedOf = (stored: Stored): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(stored.owners, (members, o) => `${o} ${members.length} ${sumOf(members, (m) => m.y)}`),
		Order.String
	)
