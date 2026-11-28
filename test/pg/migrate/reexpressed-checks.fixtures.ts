/** What the property of reexpressed-checks.test.ts reads: its space, the schema's two versions and the migration over
 * stored rows. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { check, relation, schema } from "#compiler/public/schema.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { Aim } from "#test/support/pg/migrate/support.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** The bound Bounded holds each row's `g` to in the first version, and in the second. */
const firstBound = 10
const secondBound = 20

/**
 * A version of O: its rows' `a` and `b`, and `g` generated from them, `a` in the first version and `b` in the second,
 * which Bounded, a CHECK on O, holds to the version's bound. The migration from the first to the second re-expresses `g`
 * in place, by SET EXPRESSION, under Bounded defined otherwise.
 */
const versionOf = (version: "first" | "second") => (name: string) => {
	const O = relation.generated(
		"O",
		{ id: pg.integer, a: pg.integer, b: pg.integer },
		["id"],
		(r) => ({
			g: generated(pg.integer, version === "first" ? r.a : r.b)
		})
	)
	const bound = version === "first" ? firstBound : secondBound
	return schema(name, [O], [check("Bounded", O, (o) => o.le(o.g, bound))])
}

/** A stored row: its `a`, the first `g`, and its `b`, the second. */
interface Row {
	readonly a: number
	readonly b: number
}

/** The stored rows, ids 0 up. */
export interface Stored {
	readonly rows: ReadonlyArray<Row>
}

export type Feature =
	| "a row the new expression takes past the first CHECK"
	| "a row the new expression keeps within the first CHECK"

/** What a stored case reaches, row by row: whether its second `g`, its `b`, passes the first bound. */
export const featuresOf = (stored: Stored): ReadonlyArray<Feature> =>
	Arr.map(stored.rows, (row): Feature =>
		row.b > firstBound
			? "a row the new expression takes past the first CHECK"
			: "a row the new expression keeps within the first CHECK"
	)

/** A row of any `a` the first Bounded holds and the `b` that `b` draws. */
const rowOf =
	(b: Gen<number>): Gen<Row> =>
	(source) => ({ a: source.draw(int(0, firstBound)), b: source.draw(b) })

/** Any `b` the second Bounded holds. */
const anyB = int(0, secondBound)

/** A leading row whose `b` `lead` draws, then up to three more rows of any `b`. */
const storedOf =
	(lead: Gen<number>): Gen<Stored> =>
	(source) => ({
		rows: [
			source.draw(rowOf(lead)),
			...upTo(source.draw(int(0, 3)), () => source.draw(rowOf(anyB)))
		]
	})

/** One to four rows, each of any `a` the first Bounded holds and any `b` the second holds. */
export const storedGen: Gen<Stored> = storedOf(anyB)

/** The stored rows each required situation is aimed at while it is pending: the generator draws the one a case's turn
 * aims at (aimed) in place of its plain draw. */
export const aims: ReadonlyArray<Aim<Stored, Feature>> = [
	[
		"a row the new expression takes past the first CHECK",
		storedOf(int(firstBound + 1, secondBound))
	],
	["a row the new expression keeps within the first CHECK", storedOf(int(0, firstBound))]
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

/** Writes the stored rows into the first version's table, as the owner, in one transaction: PostgreSQL computes `g`. */
const inserted = (owner: RawSession, schemaName: string, stored: Stored) =>
	Effect.gen(function* () {
		const { table, column } = namesOf(schemaName)
		yield* owner.query("BEGIN", [])
		yield* owner.query(
			`INSERT INTO ${table("O")} (${column("id")}, ${column("a")}, ${column("b")}) VALUES ${Arr.join(
				Arr.map(stored.rows, (row, id) => `(${id}, ${row.a}, ${row.b})`),
				", "
			)}`,
			[]
		)
		yield* owner.query("COMMIT", [])
	})

/**
 * The installation of the first version, over the stored rows written into it, migrated to the second, the folder
 * drafted from the snapshot before and applied by the real runner; then each row's `b` and `g` as the migration left
 * them, and no constraint of it left NOT VALID.
 */
export const migratedOver = (stored: Stored) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		let schemaName = ""
		const m = yield* migrated({
			label: "reexpressed",
			schemaName: { kind: "unique" },
			first: (name) => {
				schemaName = name
				return { schema: versionOf("first")(name), logins: [] }
			},
			later: [(name) => ({ schema: versionOf("second")(name), logins: [] })],
			apply: { kind: "noPlaceholders" },
			declared: () => noDeclarations,
			observe: Option.some((version: number, owner: RawSession) =>
				version === 0 ? inserted(owner, schemaName, stored) : Effect.void
			)
		})
		const { table, column } = namesOf(m.declared)
		const read = yield* s.admin.queryValues(
			`SELECT ${Arr.join(
				Arr.map(["id", "b", "g"], (f) => `${column(f)}::text`),
				", "
			)} FROM ${table("O")}`,
			[]
		)
		const unvalidated = yield* s.admin.queryValues(
			`SELECT count(*)::int4 FROM pg_catalog.pg_constraint WHERE connamespace = '${quoteIdent(m.schema)}'::regnamespace AND NOT convalidated`,
			[]
		)
		assert.deepEqual(Arr.flatten(unvalidated), [0], "VALIDATE leaves no constraint NOT VALID")
		const rows: ReadonlyArray<string> = Arr.sort(
			Arr.map(read, (row) => Arr.join(Arr.map(row, String), " ")),
			Order.String
		)
		return rows
	})

/** Each row's `b` and its second `g`, `b` itself, as the second version holds them, by the stored rows. */
export const expectedOf = (stored: Stored): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(stored.rows, (row, id) => `${id} ${row.b} ${row.b}`),
		Order.String
	)
