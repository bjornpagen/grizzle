/** What the properties of substrate.test.ts read: their spaces, the schemas they draw, and their judgments. */

import {
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	string,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { indices } from "#compiler/core/array.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { qualified } from "#test/support/substrate.ts"
import { rolePrefix } from "#test/support/substrate/names.ts"
import type { SubstrateShape } from "#test/support/substrate/substrate.ts"

/** A kind of object a test may create in its database under a name of its own. */
type Stray =
	| "a table"
	| "a view"
	| "a sequence"
	| "a function"
	| "a domain"
	| "an enum"
	| "a schema"

export const strays: Arr.NonEmptyReadonlyArray<Stray> = [
	"a table",
	"a view",
	"a sequence",
	"a function",
	"a domain",
	"an enum",
	"a schema"
]

/** A stray's statements, its creation and its removal, and the line the leftover listing names it by. */
const strayOf = (
	kind: Stray,
	name: string
): { readonly create: string; readonly drop: string; readonly listed: string } => {
	const inPublic = `public.${quoteIdent(name)}`
	switch (kind) {
		case "a table":
			return {
				create: `CREATE TABLE ${inPublic} ("k" int4)`,
				drop: `DROP TABLE ${inPublic}`,
				listed: `relation public.${name}`
			}
		case "a view":
			return {
				create: `CREATE VIEW ${inPublic} AS SELECT 1 AS "k"`,
				drop: `DROP VIEW ${inPublic}`,
				listed: `relation public.${name}`
			}
		case "a sequence":
			return {
				create: `CREATE SEQUENCE ${inPublic}`,
				drop: `DROP SEQUENCE ${inPublic}`,
				listed: `relation public.${name}`
			}
		case "a function":
			return {
				create: `CREATE FUNCTION ${inPublic}() RETURNS int4 LANGUAGE sql IMMUTABLE RETURN 1`,
				drop: `DROP FUNCTION ${inPublic}()`,
				listed: `routine public.${name}`
			}
		case "a domain":
			return {
				create: `CREATE DOMAIN ${inPublic} AS int4`,
				drop: `DROP DOMAIN ${inPublic}`,
				listed: `type public.${name}`
			}
		case "an enum":
			return {
				create: `CREATE TYPE ${inPublic} AS ENUM ('a')`,
				drop: `DROP TYPE ${inPublic}`,
				listed: `type public.${name}`
			}
		case "a schema":
			return {
				create: `CREATE SCHEMA ${quoteIdent(name)}`,
				drop: `DROP SCHEMA ${quoteIdent(name)}`,
				listed: `schema ${name}`
			}
	}
}

const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")

/**
 * A case: the strays it plants, none (an arm of its own, so the clean database is drawn) or a drawn subset, each named
 * `stray_<kind's index>_<word>`.
 */
interface Planting {
	readonly strays: ReadonlyArray<Stray>
	readonly word: string
}

export const plantingGen: Gen<Planting> = (source) => ({
	strays: source.draw(
		weighted<ReadonlyArray<Stray>>([
			[1, constant([])],
			[3, subarray(strays)]
		])
	),
	word: source.draw(string(characterOf(lowercase), { min: 1, max: 6 }))
})

/** A case's strays, each with its statements and the line the leftover listing names it by (strayOf). */
export const plantedOf = (p: Planting) =>
	Arr.map(p.strays, (kind, i) => strayOf(kind, `stray_${i}_${p.word}`))

/** What a case planted: each kind of stray, or none. */
export type LeftoverFeature = Stray | "clean"

/** What a drawn table's `ref` column references: nothing, its own key, or an earlier table's. */
type Reference =
	| { readonly kind: "none" }
	| { readonly kind: "itself" }
	| { readonly kind: "earlier"; readonly table: number }

/**
 * A drawn table `t<i>`, keyed by `k`: plain, or partitioned with the one partition `t<i>_part` that holds every key;
 * its reference; and its rows, the keys 0 … rows − 1, each referencing key 0 of the table it references, or NULL where
 * that table holds no row.
 */
interface DrawnTable {
	readonly partitioned: boolean
	readonly reference: Reference
	readonly rows: number
}

/** A schema a test owns whole: its tables, and whether a view and a sequence sit beside them. */
interface DrawnSchema {
	readonly tables: ReadonlyArray<DrawnTable>
	readonly view: boolean
	readonly sequence: boolean
}

const referenceGen =
	(table: number): Gen<Reference> =>
	(source) =>
		source.draw(
			element<Reference>([
				{ kind: "none" },
				{ kind: "itself" },
				...Arr.map(indices(table), (earlier): Reference => ({ kind: "earlier", table: earlier }))
			])
		)

export const drawnSchemaGen: Gen<DrawnSchema> = (source) => ({
	tables: Arr.map(indices(source.draw(int(0, 4))), (table) => ({
		partitioned: source.draw(boolean),
		reference: source.draw(referenceGen(table)),
		rows: source.draw(int(0, 3))
	})),
	view: source.draw(boolean),
	sequence: source.draw(boolean)
})

/** Every table a drawn schema holds: each drawn table, and the partition of each partitioned one. */
export const drawnTablesOf = (d: DrawnSchema): ReadonlyArray<string> =>
	Arr.flatMap(d.tables, (t, i) => (t.partitioned ? [`t${i}`, `t${i}_part`] : [`t${i}`]))

/** The table a drawn table's reference names, by its index: none, its own, or an earlier one's. */
const referencedOf = (i: number, reference: Reference): Option.Option<number> => {
	switch (reference.kind) {
		case "none":
			return Option.none()
		case "itself":
			return Option.some(i)
		case "earlier":
			return Option.some(reference.table)
	}
}

/** Whether the table drawn table `i` references holds a row, so its rows reference key 0 rather than NULL. */
const referencesRows = (d: DrawnSchema, i: number, reference: Reference): boolean =>
	Option.exists(
		Option.flatMap(referencedOf(i, reference), (j) => Arr.get(d.tables, j)),
		(t) => t.rows > 0
	)

/**
 * A drawn schema's DDL and rows in `schema`: each table in order, its partition and its rows, then the view and the
 * sequence.
 */
export const drawnSql = (schema: string, d: DrawnSchema): ReadonlyArray<string> => [
	...Arr.flatMap(d.tables, (t, i) => {
		const table = qualified(schema, `t${i}`)
		const clause = Option.match(referencedOf(i, t.reference), {
			onNone: () => "",
			onSome: (j) => ` REFERENCES ${qualified(schema, `t${j}`)} (k)`
		})
		return [
			`CREATE TABLE ${table} (k int4 PRIMARY KEY, ref int4${clause})${t.partitioned ? " PARTITION BY RANGE (k)" : ""}`,
			...(t.partitioned
				? [
						`CREATE TABLE ${qualified(schema, `t${i}_part`)} PARTITION OF ${table} FOR VALUES FROM (MINVALUE) TO (MAXVALUE)`
					]
				: []),
			...(t.rows > 0
				? [
						`INSERT INTO ${table} (k, ref) SELECT g, ${referencesRows(d, i, t.reference) ? "0" : "NULL"} FROM pg_catalog.generate_series(0, ${t.rows - 1}) AS g`
					]
				: [])
		]
	}),
	...(d.view ? [`CREATE VIEW ${qualified(schema, "v")} AS SELECT 1 AS k`] : []),
	...(d.sequence ? [`CREATE SEQUENCE ${qualified(schema, "seq")}`] : [])
]

export type ClearingFeature =
	| "no table"
	| "a partitioned table"
	| "a reference to itself"
	| "a reference to an earlier table that holds rows"
	| "a table with no row"
	| "a view beside"
	| "a sequence beside"

export const clearingFeatures: Arr.NonEmptyReadonlyArray<ClearingFeature> = [
	"no table",
	"a partitioned table",
	"a reference to itself",
	"a reference to an earlier table that holds rows",
	"a table with no row",
	"a view beside",
	"a sequence beside"
]

/** What a drawn schema reaches. */
export const clearingFeaturesOf = (d: DrawnSchema): ReadonlyArray<ClearingFeature> =>
	Arr.filter(clearingFeatures, (feature) => {
		switch (feature) {
			case "no table":
				return d.tables.length === 0
			case "a partitioned table":
				return Arr.some(d.tables, (t) => t.partitioned)
			case "a reference to itself":
				return Arr.some(d.tables, (t) => t.reference.kind === "itself")
			case "a reference to an earlier table that holds rows":
				return Arr.some(
					d.tables,
					(t, i) => t.reference.kind === "earlier" && referencesRows(d, i, t.reference)
				)
			case "a table with no row":
				return Arr.some(d.tables, (t) => t.rows === 0)
			case "a view beside":
				return d.view
			case "a sequence beside":
				return d.sequence
		}
	})

/**
 * Who creates a role under a schema's prefix: the substrate (SubstrateShape role), which gives each its own finalizer,
 * or an installation's migration, whose world roles nothing but the schema's release drops.
 */
const creators = ["the substrate", "an installation"] as const

type Creator = (typeof creators)[number]

/** A released schema: the creators of the roles it holds under its prefix when it is released, none for a bare one. */
interface Releasing {
	readonly creators: ReadonlyArray<Creator>
}

export const releasingGen: Gen<Releasing> = (source) => ({
	creators: source.draw(subarray(creators))
})

/** What a released schema held: a role each creator made, roles of both in one schema, or no role. */
export type ReleaseFeature = `a role ${Creator} created` | "roles of both creators" | "no role"

/** The creators a steered case gives its schema to reach each feature (releaseAims). */
const reaching: Readonly<Record<ReleaseFeature, ReadonlyArray<Creator>>> = {
	"a role the substrate created": ["the substrate"],
	"a role an installation created": ["an installation"],
	"roles of both creators": creators,
	"no role": []
}

/** Every situation the released-roles property requires, the order a steered case's turn aims at them in. */
export const releaseFeatures = [
	"a role the substrate created",
	"a role an installation created",
	"roles of both creators",
	"no role"
] as const satisfies ReadonlyArray<ReleaseFeature>

/** Each feature, with the schema a case whose turn aims at it releases (aimed): one its creators reach. */
export const releaseAims: ReadonlyArray<readonly [ReleaseFeature, Gen<Releasing>]> = Arr.map(
	releaseFeatures,
	(feature) => [feature, constant({ creators: reaching[feature] })] as const
)

/** Every role on the substrate's member whose name starts with the prefix of the allocated schema name `schema`. */
export const rolesUnder = (s: SubstrateShape, schema: string) =>
	Effect.map(
		s.admin.queryValues(
			"SELECT rolname::text FROM pg_catalog.pg_roles WHERE starts_with(rolname::text, $1::text) ORDER BY 1",
			[rolePrefix(schema)]
		),
		(rows) => Arr.map(rows, ([role]) => String(role))
	)
