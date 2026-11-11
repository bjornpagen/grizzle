import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
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
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Formatter, Layer, Option, Order } from "effect"
import { indices } from "#compiler/core/array.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { qualified } from "#test/support/substrate.ts"
import { clearRows, schemaGroup } from "#test/support/substrate/replace.ts"
import { leftovers } from "#test/support/substrate/shared.ts"
import {
	freshSchema,
	ownerSession,
	Substrate,
	type SubstrateShape
} from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * What the native multi-session test substrate judges a test to leave behind in a shared database: every object a
 * clean test database does not hold. Its sessions, psql writers and expectations are the substrate every other pg
 * suite runs on, the lock barrier among them under every schedule (test/support/schedules/interleave.ts); psql's
 * native errors are the direct-writer suites' (test/pg/direct-writers); the expectations' judgment is the unit tier's
 * (test/unit/substrate).
 *
 * The property plants a drawn set of strays, each a kind of object a test may create in a shared database under a name
 * of its own, and requires the leftover listing to name exactly those strays, and none once they are dropped. A drawn
 * case leaves its strays to its claim's release instead, in a claim of its own: the release fails, and no later claim
 * is given a dirty database (the sweep drops it once no file runs, which this file cannot observe).
 *
 * The clearing property draws a schema a test owns whole, as a substrate proof's seat is: its tables, plain or
 * partitioned, each referencing nothing, itself or an earlier table, with rows or none, and a view and a sequence beside
 * them. It clears the schema by its catalog group (substrate/replace.ts schemaGroup, clearRows), on a session of its own
 * as a seat's, and requires every table it drew to hold no row and no page after: a table left out of the group keeps
 * its rows or refuses the TRUNCATE of the table it references (0A000), a relation that is no table put in it refuses
 * the TRUNCATE (42809), and a DELETE leaves the pages of the versions it removed.
 *
 * Plants (main's test phase): substrate-leftovers-miss-routines.patch,
 * substrate-clearing-occupied-skips-referencing.patch.
 */
type Stray =
	| "a table"
	| "a view"
	| "a sequence"
	| "a function"
	| "a domain"
	| "an enum"
	| "a schema"

const strays: Arr.NonEmptyReadonlyArray<Stray> = [
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
 * `stray_<kind's index>_<word>`, and whether its claim's release meets them.
 */
interface Planting {
	readonly strays: ReadonlyArray<Stray>
	readonly word: string
	readonly released: boolean
}

const plantingGen: Gen<Planting> = (source) => ({
	strays: source.draw(
		weighted<ReadonlyArray<Stray>>([
			[1, constant([])],
			[3, subarray(strays)]
		])
	),
	word: source.draw(string(characterOf(lowercase), { min: 1, max: 6 })),
	released: source.draw(
		weighted<boolean>([
			[5, () => false],
			[1, () => true]
		])
	)
})

const plantedOf = (p: Planting) =>
	Arr.map(p.strays, (kind, i) => strayOf(kind, `stray_${i}_${p.word}`))

type LeftoverFeature = Stray | "clean" | "a dirty release refused"

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

const drawnSchemaGen: Gen<DrawnSchema> = (source) => ({
	tables: Arr.map(indices(source.draw(int(0, 4))), (table) => ({
		partitioned: source.draw(boolean),
		reference: source.draw(referenceGen(table)),
		rows: source.draw(int(0, 3))
	})),
	view: source.draw(boolean),
	sequence: source.draw(boolean)
})

/** Every table a drawn schema holds: each drawn table, and the partition of each partitioned one. */
const drawnTablesOf = (d: DrawnSchema): ReadonlyArray<string> =>
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
const drawnSql = (schema: string, d: DrawnSchema): ReadonlyArray<string> => [
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

type ClearingFeature =
	| "no table"
	| "a partitioned table"
	| "a reference to itself"
	| "a reference to an earlier table that holds rows"
	| "a table with no row"
	| "a view beside"
	| "a sequence beside"

const clearingFeatures: Arr.NonEmptyReadonlyArray<ClearingFeature> = [
	"no table",
	"a partitioned table",
	"a reference to itself",
	"a reference to an earlier table that holds rows",
	"a table with no row",
	"a view beside",
	"a sequence beside"
]

/** What a drawn schema reaches. */
const clearingFeaturesOf = (d: DrawnSchema): ReadonlyArray<ClearingFeature> =>
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

layer(Substrate.layer)("native PG test substrate", (it) => {
	it.effect(
		"lists exactly the strays a test leaves in a shared database, fails the release of a claim that leaves any, and gives no later claim a dirty database",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "substrate/leftovers",
						draw: drawn(plantingGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the strays planted, each named by the line of its kind, and none once they are dropped"
						},
						coverage: required<LeftoverFeature>([...strays, "clean", "a dirty release refused"], {
							cases: 60,
							sense: notesOnly
						}),
						kept: [],
						runs: 16,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) =>
						Effect.gen(function* () {
							const planted = plantedOf(p)
							const plant = (substrate: SubstrateShape) =>
								Effect.forEach(planted, (s) => substrate.admin.query(s.create, []), {
									discard: true
								})
							if (p.released && Arr.isReadonlyArrayNonEmpty(planted)) {
								/** Each claim is a substrate of its own, built fresh: the suite's is memoized under the same layer. */
								const exit = yield* Effect.exit(
									Effect.flatMap(Substrate, plant).pipe(withLayer(Layer.fresh(Substrate.layer)))
								)
								assert.ok(
									Exit.isFailure(exit),
									"the release of a claim that left objects behind fails"
								)
								const after = yield* Effect.flatMap(Substrate, (substrate) =>
									leftovers(substrate.admin)
								).pipe(withLayer(Layer.fresh(Substrate.layer)))
								assert.deepEqual(after, [])
								c.note("a dirty release refused")
								return
							}
							const s = yield* Substrate
							yield* plant(s)
							const listed = yield* leftovers(s.admin)
							yield* Effect.forEach(
								Arr.reverse(planted),
								(stray) => s.admin.query(stray.drop, []),
								{
									discard: true
								}
							)
							assert.deepEqual(
								Arr.sort(listed, Order.String),
								Arr.sort(
									Arr.map(planted, (stray) => stray.listed),
									Order.String
								)
							)
							const cleared = yield* leftovers(s.admin)
							assert.deepEqual(cleared, [])
							c.noteAll(p.strays)
							if (!Arr.isReadonlyArrayNonEmpty(planted)) {
								c.note("clean")
							}
						})
				)
			)
	)

	it.effect(
		"clears every table of a schema a test owns whole, partitioned or referenced, to no row and no page, whatever views and sequences sit beside them",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const session = yield* s.session({ ...ownerSession(), label: "clearing" })
					return yield* explore(
						{
							suite: "substrate/clearing",
							draw: drawn(drawnSchemaGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "every table the schema's DDL created holds no row and no page"
							},
							coverage: required<ClearingFeature>(clearingFeatures, {
								cases: 60,
								sense: notesOnly
							}),
							kept: [],
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(d, c) =>
							Effect.gen(function* () {
								const schema = yield* s.schema(freshSchema)
								yield* Effect.forEach(drawnSql(schema, d), (sql) => s.admin.query(sql, []), {
									discard: true
								})
								const group = yield* schemaGroup(s.admin, schema)
								yield* clearRows(session, group)
								const tables = Arr.map(drawnTablesOf(d), (t) => qualified(schema, t))
								const held = yield* Effect.forEach(tables, (table) =>
									Effect.map(
										s.admin.queryValues(
											`SELECT count(*)::int4, pg_catalog.pg_relation_size($1::text::regclass)::int4 FROM ${table}`,
											[table]
										),
										(rows) =>
											Arr.map(
												rows,
												([count, bytes]) =>
													`${table} holds ${Number(count)} rows in ${Number(bytes)} bytes`
											)
									)
								)
								assert.deepEqual(
									held,
									Arr.map(tables, (table) => [`${table} holds 0 rows in 0 bytes`])
								)
								c.noteAll(clearingFeaturesOf(d))
							})
					)
				})
			)
	)
})
