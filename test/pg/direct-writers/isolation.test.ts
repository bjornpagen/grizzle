/**
 * Every write to a grizzle table runs at SERIALIZABLE (a direct SQL writer must use SERIALIZABLE), as a model
 * over the whole small box of planted writers.
 *
 * One schema of four relations, one per kind of table a writer meets: a law-bearing mutable relation (Team, the target
 * of a foreign key and the relation of a row check), a law-bearing immutable one (Member, the foreign key's source),
 * and a lawless immutable and mutable one (Note, Tag). Every law is native, so a table's guard is its one trigger.
 *
 * The planted premise: before the installation, the database names no default level, so a new session runs
 * PostgreSQL's own, READ COMMITTED; the installation must set the database's default to SERIALIZABLE itself.
 *
 * Every point of the box is a transaction: a level (the database's default, which a transaction begun with no level
 * takes, SERIALIZABLE, READ COMMITTED, REPEATABLE READ, READ UNCOMMITTED), an actor (the `writer`, a session in the
 * schema's full world, granted every write grizzle grants, or the schema's owner, who holds every privilege), a
 * statement (an INSERT, an UPDATE, a DELETE of one row, a DELETE of no row, a TRUNCATE ... CASCADE, a MERGE that
 * inserts, a MERGE that updates, a MERGE that deletes, a SELECT) and a table, and a write's transaction reads its table
 * first or not, since a guard fires at the write whatever the transaction read. The model names its outcome from that
 * point alone, in the order PostgreSQL meets each refusal:
 *
 * - a SELECT is admitted at every level, and its transaction commits;
 * - the privilege check at executor start comes first: the writer's TRUNCATE (granted to no one) and its UPDATE of an
 *   immutable relation, plain or a MERGE's, are 42501 at every level;
 * - then the table's guard, a BEFORE statement trigger that fires whatever rows the statement matches: below
 *   SERIALIZABLE every other write is 25000, its SCHEMA and TABLE fields naming the table, and the transaction's COMMIT
 *   is answered with ROLLBACK, so it commits nothing;
 * - at SERIALIZABLE, and at the database's default, which the installation set to it, every other write runs (each
 *   transaction then rolls back, so every point starts from one state).
 *
 * That every table, the migrations ledger included, carries exactly one guard, BEFORE every write, per statement and
 * enabled, and that the database's settings name SERIALIZABLE, is the installed-catalog checker's, which every
 * installation runs (test/support/catalog/installed.ts).
 *
 * The file resets a database setting, so it runs in a database of its own (Substrate.isolatedLayer).
 *
 * - Property: at every point of the box, the outcome PostgreSQL gives is the model's, and every table holds its starting
 *   rows after the point (a refusal that wrote anyway, or an admitted write that committed, fails).
 * - Oracle: the specification turned into a checker (predict), the README's refusal order over the point.
 * - Features: each statement under each verdict, the guard's refusal on each kind of table and after a read, and a write
 *   admitted at the database's default.
 * - Plants: ~/.cache/grizzle-release/BR08/plants/isolation-guard-admits-repeatable-read.patch (the guard compares
 *   against REPEATABLE READ), ~/.cache/grizzle-release/BR08/plants/isolation-no-database-default.patch (the
 *   installation leaves the database's default level alone); each must turn the property red.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { exact, ordered, set, structuralHash } from "@grizzle/testing/oracle"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { pg } from "#compiler/public/fields.ts"
import { check, contained, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

const Team = relation("Team", { id: pg.integer, cap: pg.integer, name: pg.integer }, ["id"])
const Member = relation("Member", { id: pg.integer, team: pg.integer, active: pg.boolean }, ["id"])
const Note = relation("Note", { id: pg.integer, body: pg.integer }, ["id"])
const Tag = relation("Tag", { id: pg.integer, body: pg.integer }, ["id"])

const Guarded = schema("Guarded", { Team, Member, Note, Tag }, [
	check("CapNotNegative", Team, (x) => x.ge(x.cap, 0)),
	contained(on(Member, "team"), on(Team, "id")),
	mutable(Team),
	mutable(Tag)
])

/** The full world every write of the writer runs in: its role holds every relation whole and writes them. */
const world = Object.freeze(fullWorld(Guarded, {}))

/**
 * A table of the box: its relation, whether it is mutable, whether a law reads it, its fields in heading order, the
 * payload an UPDATE sets to itself, and a fresh row.
 */
interface Table {
	readonly relation: typeof Team | typeof Member | typeof Note | typeof Tag
	readonly mutable: boolean
	readonly lawful: boolean
	readonly fields: ReadonlyArray<string>
	readonly payload: string
	/** Rows 1 and 2 of the starting state; a member refers to team 1 alone, so no row 2 is referred to. */
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
	/** A row of an id no stored row holds, lawful at its statement. */
	readonly fresh: ReadonlyArray<string>
}

const tables: Arr.NonEmptyReadonlyArray<Table> = [
	{
		relation: Team,
		mutable: true,
		lawful: true,
		fields: ["id", "cap", "name"],
		payload: "name",
		rows: [
			["1", "5", "1"],
			["2", "5", "2"]
		],
		fresh: ["3", "5", "3"]
	},
	{
		relation: Member,
		mutable: false,
		lawful: true,
		fields: ["id", "team", "active"],
		payload: "active",
		rows: [
			["1", "1", "true"],
			["2", "1", "false"]
		],
		fresh: ["3", "1", "false"]
	},
	{
		relation: Note,
		mutable: false,
		lawful: false,
		fields: ["id", "body"],
		payload: "body",
		rows: [
			["1", "1"],
			["2", "2"]
		],
		fresh: ["3", "3"]
	},
	{
		relation: Tag,
		mutable: true,
		lawful: false,
		fields: ["id", "body"],
		payload: "body",
		rows: [
			["1", "1"],
			["2", "2"]
		],
		fresh: ["3", "3"]
	}
]

const levels = [
	"the database's default",
	"serializable",
	"read committed",
	"repeatable read",
	"read uncommitted"
] as const
type Level = (typeof levels)[number]
const actors = ["writer", "owner"] as const
type Actor = (typeof actors)[number]
const statements = [
	"insert",
	"update",
	"delete",
	"delete of no row",
	"truncate",
	"merge insert",
	"merge update",
	"merge delete",
	"select"
] as const
type Statement = (typeof statements)[number]
const writes = Object.freeze(Arr.filter(statements, (s) => s !== "select"))

/**
 * A point of the box: a level, an actor and a statement, over a table, the level outermost, and for a write whether its
 * transaction reads the table first, which a read alone already does.
 */
type Point = readonly [readonly [Level, Actor, Statement], Table, boolean]

const box: Gen<Point> = (source) => {
	const level = source.draw(element(levels))
	const actor = source.draw(element(actors))
	const statement = source.draw(element(statements))
	return [
		[level, actor, statement] as const,
		source.draw(element(tables)),
		statement === "select" ? false : source.draw(boolean)
	] as const
}

/** What the model names for a point of the box. */
type Verdict =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused by privilege" }
	| { readonly kind: "refused by the guard"; readonly table: Table }

const predict = (level: Level, actor: Actor, statement: Statement, table: Table): Verdict => {
	if (statement === "select") {
		return { kind: "admitted" }
	}
	if (
		actor === "writer" &&
		(statement === "truncate" ||
			((statement === "update" || statement === "merge update") && !table.mutable))
	) {
		return { kind: "refused by privilege" }
	}
	return level === "serializable" || level === "the database's default"
		? { kind: "admitted" }
		: { kind: "refused by the guard", table }
}

type TableKind = `${"law-bearing" | "lawless"} ${"mutable" | "immutable"}`
const tableKind = (t: Table): TableKind =>
	`${t.lawful ? "law-bearing" : "lawless"} ${t.mutable ? "mutable" : "immutable"}`

type IsolationFeature =
	| `${Statement}: ${Verdict["kind"]}`
	| `${TableKind}: refused by the guard`
	| "a write at the database's default admitted"
	| "a write refused by the guard after a read"

/** A table's name in the installation, schema-qualified and quoted. */
const tableName = (names: Names, table: Table): string => names.table(table.relation)

/** A field's column in the installation, quoted. */
const columnName = (names: Names, table: Table, field: string): string =>
	quoteIdent(names.columnIdent(table.relation, field))

/** The statement's SQL over the installation `names`. */
const sqlOf = (names: Names, statement: Statement, table: Table): string => {
	const name = tableName(names, table)
	const columns = Arr.map(table.fields, (f) => columnName(names, table, f))
	const id = columnName(names, table, "id")
	const payload = columnName(names, table, table.payload)
	switch (statement) {
		case "insert":
			return `INSERT INTO ${name} (${Arr.join(columns, ", ")}) VALUES (${Arr.join(table.fresh, ", ")})`
		case "update":
			return `UPDATE ${name} SET ${payload} = ${payload} WHERE ${id} = 1`
		case "delete":
			return `DELETE FROM ${name} WHERE ${id} = 2`
		case "delete of no row":
			return `DELETE FROM ${name} WHERE ${id} = 99`
		case "truncate":
			return `TRUNCATE ${name} CASCADE`
		case "merge insert":
			return `MERGE INTO ${name} AS "r" USING (VALUES (${Arr.join(table.fresh, ", ")})) AS "s" (${Arr.join(columns, ", ")}) ON "r".${id} = "s".${id} WHEN NOT MATCHED THEN INSERT (${Arr.join(columns, ", ")}) VALUES (${Arr.join(
				Arr.map(columns, (c) => `"s".${c}`),
				", "
			)})`
		case "merge update":
			return `MERGE INTO ${name} AS "r" USING (VALUES (1)) AS "s" (${id}) ON "r".${id} = "s".${id} WHEN MATCHED THEN UPDATE SET ${payload} = "r".${payload}`
		case "merge delete":
			return `MERGE INTO ${name} AS "r" USING (VALUES (2)) AS "s" (${id}) ON "r".${id} = "s".${id} WHEN MATCHED THEN DELETE`
		case "select":
			return `SELECT count(*) FROM ${name}`
	}
}

/** The starting state, loaded as the owner over emptied tables. */
const loadState = (names: Names): ReadonlyArray<string> => [
	`TRUNCATE ${Arr.join(
		Arr.map(tables, (t) => tableName(names, t)),
		", "
	)}`,
	...Arr.map(
		tables,
		(t) =>
			`INSERT INTO ${tableName(names, t)} (${Arr.join(
				Arr.map(t.fields, (f) => columnName(names, t, f)),
				", "
			)}) VALUES ${Arr.join(
				Arr.map(t.rows, (r) => `(${Arr.join(r, ", ")})`),
				", "
			)}`
	)
]

/** What a session met running one statement in a transaction begun at `level`, and how the transaction ended. */
type Met =
	| { readonly kind: "ran"; readonly committed: boolean }
	| {
			readonly kind: "refused"
			readonly code: string
			readonly schema: Option.Option<string>
			readonly table: Option.Option<string>
	  }

/** A point's answer as a failure message names it. */
const shownMet = (met: Met): string => {
	switch (met.kind) {
		case "ran":
			return met.committed ? "ran, committed" : "ran, not committed"
		case "refused":
			return `refused with ${met.code}${Option.match(met.table, { onNone: () => "", onSome: (table) => ` naming ${Option.getOrElse(met.schema, () => "no schema")}.${table}` })}`
	}
}

/** One point's transaction: begun at `level`, `before` read and admitted, then `sql`, which ends it. */
const runPoint = (
	session: RawSession,
	level: Level,
	before: ReadonlyArray<string>,
	sql: string,
	readOnly: boolean
): Effect.Effect<Met> =>
	Effect.gen(function* () {
		yield* Effect.orDie(
			session.query(
				level === "the database's default"
					? "BEGIN"
					: `BEGIN ISOLATION LEVEL ${Str.toUpperCase(level)}`,
				[]
			)
		)
		for (const read of before) {
			yield* Effect.orDie(session.query(read, []))
		}
		const ran = yield* Effect.result(session.query(sql, []))
		if (Result.isFailure(ran)) {
			const fields = defined(pgErrorFields(ran.failure), `${sql}: a server error`)
			/** The aborted transaction's COMMIT is answered with ROLLBACK: nothing it did is committed. */
			const ended = yield* Effect.result(session.commit)
			assert.ok(Result.isFailure(ended), `${sql}: an aborted transaction does not commit`)
			return { kind: "refused", code: fields.code, schema: fields.schema, table: fields.table }
		}
		if (!readOnly) {
			yield* Effect.orDie(session.rollback)
			return { kind: "ran", committed: false }
		}
		const ended = yield* Effect.result(session.commit)
		return { kind: "ran", committed: Result.isSuccess(ended) }
	})

const rowsAgree = set(structuralHash, ordered(exact))

layer(Substrate.isolatedLayer, { excludeTestServices: true })(
	"every write to a grizzle table runs at SERIALIZABLE",
	(it) => {
		it.effect(
			"a write below SERIALIZABLE is refused with 25000 naming its table, after privilege, the database's default being the SERIALIZABLE the installation set; a read is admitted",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						yield* s.admin.query(
							`ALTER DATABASE ${quoteIdent(s.database)} RESET default_transaction_isolation`,
							[]
						)
						const before = yield* Effect.scoped(
							Effect.flatMap(s.session({ ...ownerSession(), label: "before" }), (o) =>
								o.values("SHOW default_transaction_isolation", [])
							)
						)
						assert.equal(before[0]?.[0], "read committed", "the planted premise")
						const installed = yield* install(Guarded, {
							ambient: ordinarySession,
							extensions: [],
							logins: [world.server],
							label: "guardbox"
						})
						const names = namesOf(installed)
						const sessions: Readonly<Record<Actor, RawSession>> = {
							writer: yield* s.session({
								...worldSession(installed.world(world.app)),
								label: "writer"
							}),
							owner: yield* s.session({ ...ownerSession(), label: "owner" })
						}
						const readState = Effect.forEach(tables, (t) =>
							Effect.map(
								s.admin.queryValues(
									`SELECT ${Arr.join(
										Arr.map(t.fields, (f) => `${columnName(names, t, f)}::text`),
										", "
									)} FROM ${tableName(names, t)}`,
									[]
								),
								(rows) => Arr.map(rows, (row) => Arr.map(row, (x) => String(x)))
							)
						)
						yield* transaction(s.admin, loadState(names))
						const situations: Arr.NonEmptyReadonlyArray<IsolationFeature> = [
							"truncate: refused by privilege",
							...Arr.flatMap(writes, (w): ReadonlyArray<IsolationFeature> => [
								`${w}: admitted`,
								`${w}: refused by the guard`
							]),
							"update: refused by privilege",
							"select: admitted",
							"a write at the database's default admitted",
							"a write refused by the guard after a read",
							...Arr.map(tables, (t): IsolationFeature => `${tableKind(t)}: refused by the guard`)
						]
						return yield* exhaust(
							{
								box: "every level (the database's default, SERIALIZABLE, READ COMMITTED, REPEATABLE READ, READ UNCOMMITTED), actor (a world role's writer, the schema's owner), statement (INSERT, UPDATE, DELETE of a row and of none, TRUNCATE, MERGE inserting, updating and deleting, SELECT), table (law-bearing or lawless, mutable or immutable), and for a write a read of its table first or none",
								oracle: {
									kind: "specification",
									name: "the README's refusal order restated (predict): a read admitted, then privilege, then the guard below SERIALIZABLE"
								},
								suite: "pg/direct-writers/isolation",
								generator: box,
								literal: Formatter.format,
								coverage: requiredInSpace<IsolationFeature>(situations),
								caseHang
							},
							([[level, actor, statement], table, readFirst], c) =>
								Effect.gen(function* () {
									const sql = sqlOf(names, statement, table)
									const reads = readFirst ? [sqlOf(names, "select", table)] : []
									const point = `${actor} at ${level}: ${Arr.join([...reads, sql], "; ")}`
									const verdict = predict(level, actor, statement, table)
									const met = yield* runPoint(
										sessions[actor],
										level,
										reads,
										sql,
										statement === "select"
									)
									switch (verdict.kind) {
										case "admitted":
											assert.ok(met.kind === "ran", `${point}: admitted, met ${shownMet(met)}`)
											if (statement === "select") {
												assert.ok(met.committed, `${point}: a read commits`)
											}
											break
										case "refused by privilege":
											assert.ok(
												met.kind === "refused" && met.code === sqlstates.insufficientPrivilege,
												`${point}: 42501, met ${shownMet(met)}`
											)
											break
										case "refused by the guard":
											assert.ok(
												met.kind === "refused" && met.code === sqlstates.invalidTransactionState,
												`${point}: 25000, met ${shownMet(met)}`
											)
											assert.deepEqual(
												[met.schema, met.table],
												[
													Option.some(names.schema),
													Option.some(names.tableIdent(verdict.table.relation))
												],
												`${point}: the refusal names the table, by its schema and name`
											)
											c.note(`${tableKind(table)}: refused by the guard`)
											if (readFirst) {
												c.note("a write refused by the guard after a read")
											}
											break
									}
									c.note(`${statement}: ${verdict.kind}`)
									if (
										level === "the database's default" &&
										statement !== "select" &&
										verdict.kind === "admitted"
									) {
										c.note("a write at the database's default admitted")
									}
									/** Every point ends rolled back or refused, so the state is the starting one. */
									const state = yield* Effect.orDie(readState)
									for (const [i, t] of tables.entries()) {
										assert.deepEqual(
											rowsAgree(defined(state[i], `${t.relation.name}'s rows`), t.rows),
											Option.none(),
											`${point}: ${t.relation.name} is as it started`
										)
									}
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
