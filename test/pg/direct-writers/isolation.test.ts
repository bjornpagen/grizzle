/**
 * Every write to a grizzle table runs at SERIALIZABLE (a direct SQL writer must use SERIALIZABLE), as a model
 * over the whole small box of planted writers.
 *
 * One schema of four relations, one per kind of table a writer meets: a law-bearing mutable relation (Team, the target
 * of a residual capacity), a law-bearing immutable one (Member, the capacity's source and a foreign key's), and a
 * lawless immutable and mutable one (Note, Tag). Every point of the box is a transaction: a level (SERIALIZABLE, READ
 * COMMITTED, REPEATABLE READ, READ UNCOMMITTED), an actor (the `writer`, a session in the schema's full world, granted
 * every write grizzle grants, or the schema's owner, who holds every privilege), a statement (an INSERT, an UPDATE, a DELETE of one
 * row, a DELETE of no row, a TRUNCATE ... CASCADE, a MERGE that inserts, a MERGE that deletes, a SELECT) and a table.
 * The model names its outcome from that point alone, in the order PostgreSQL meets each refusal:
 *
 * - a SELECT is admitted at every level, and its transaction commits;
 * - the privilege check at executor start comes first: the writer's TRUNCATE (granted to no one) and its UPDATE of an
 *   immutable relation are 42501 at every level;
 * - then the table's guard, a BEFORE statement trigger that fires whatever rows the statement matches: below
 *   SERIALIZABLE every other write is 25000, its TABLE field naming the table, and the transaction commits nothing;
 * - at SERIALIZABLE every other write runs (each transaction then rolls back, so every point starts from one state).
 *
 * The installation states the same promise in the catalog, read without the installer: the database default is
 * SERIALIZABLE (pg_db_role_setting, and SHOW in a new session of the writer), which the test first resets so the
 * installer must set it; and every table of the schema, the migrations ledger included, carries exactly one guard
 * trigger, BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE, FOR EACH STATEMENT, enabled.
 *
 * The file resets a database setting, so it runs in a database of its own (Substrate.isolatedLayer).
 *
 * The planted premise: the database names no default level, so a new session runs PostgreSQL's own.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { exact, ordered, set } from "@grizzle/testing/oracle"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Result, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	capacity,
	contained,
	mutable,
	on,
	ref,
	relation,
	schema,
	select,
	within
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { isLedgerObject, parsedName } from "#test/support/kernel/naming.ts"
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
	capacity(on(Team, "id"), {
		from: on(select(Member, { active: true }), "team"),
		within: within(0n, ref("cap"))
	}),
	contained(on(Member, "team"), on(Team, "id")),
	mutable(Team),
	mutable(Tag)
])

/** The full world every write of the writer runs in: its role holds every relation whole and writes them. */
const world = fullWorld(Guarded)

/**
 * A table of the box: its relation, whether it is mutable, whether a law reads it, its fields in heading order, the
 * payload an UPDATE sets to itself, and a fresh row.
 */
interface Table {
	readonly relation: string
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
		relation: "Team",
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
		relation: "Member",
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
		relation: "Note",
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
		relation: "Tag",
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

const levels = ["serializable", "read committed", "repeatable read", "read uncommitted"] as const
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
	"merge delete",
	"select"
] as const
type Statement = (typeof statements)[number]
const writes = Arr.filter(statements, (s) => s !== "select")

/** A point of the box: a level, an actor and a statement, over a table, the level outermost. */
type Point = readonly [readonly [Level, Actor, Statement], Table]

const box: Gen<Point> = (source) =>
	[
		[
			source.draw(element(levels)),
			source.draw(element(actors)),
			source.draw(element(statements))
		] as const,
		source.draw(element(tables))
	] as const

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
		(statement === "truncate" || (statement === "update" && !table.mutable))
	) {
		return { kind: "refused by privilege" }
	}
	return level === "serializable" ? { kind: "admitted" } : { kind: "refused by the guard", table }
}

type TableKind = `${"law-bearing" | "lawless"} ${"mutable" | "immutable"}`
const tableKind = (t: Table): TableKind =>
	`${t.lawful ? "law-bearing" : "lawless"} ${t.mutable ? "mutable" : "immutable"}`

type IsolationFeature = `${Statement}: ${Verdict["kind"]}` | `${TableKind}: refused by the guard`

/** The statement's SQL over the installed schema `q`. */
const sqlOf = (q: string, statement: Statement, table: Table): string => {
	const name = `${q}.${quoteIdent(identifierOf(identity.table(parsedName(table.relation))))}`
	const columns = Arr.map(table.fields, (f) =>
		quoteIdent(identifierOf(identity.column(parsedName(f))))
	)
	const id = quoteIdent(identifierOf(identity.column(parsedName("id"))))
	const payload = quoteIdent(identifierOf(identity.column(parsedName(table.payload))))
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
		case "merge delete":
			return `MERGE INTO ${name} AS "r" USING (VALUES (2)) AS "s" (${id}) ON "r".${id} = "s".${id} WHEN MATCHED THEN DELETE`
		case "select":
			return `SELECT count(*) FROM ${name}`
	}
}

/** The starting state, loaded as the owner over emptied tables. */
const loadState = (q: string): ReadonlyArray<string> => [
	`TRUNCATE ${Arr.join(
		Arr.map(
			tables,
			(t) => `${q}.${quoteIdent(identifierOf(identity.table(parsedName(t.relation))))}`
		),
		", "
	)}`,
	...Arr.map(
		tables,
		(t) =>
			`INSERT INTO ${q}.${quoteIdent(identifierOf(identity.table(parsedName(t.relation))))} (${Arr.join(
				Arr.map(t.fields, (f) => quoteIdent(identifierOf(identity.column(parsedName(f))))),
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
	| { readonly kind: "refused"; readonly code: string; readonly table: Option.Option<string> }

/** A point's answer as a failure message names it. */
const shownMet = (met: Met): string => {
	switch (met.kind) {
		case "ran":
			return met.committed ? "ran, committed" : "ran, not committed"
		case "refused":
			return `refused with ${met.code}${Option.match(met.table, { onNone: () => "", onSome: (table) => ` naming ${table}` })}`
	}
}

const runPoint = (
	session: RawSession,
	level: Level,
	sql: string,
	readOnly: boolean
): Effect.Effect<Met> =>
	Effect.gen(function* () {
		yield* Effect.orDie(session.query(`BEGIN ISOLATION LEVEL ${Str.toUpperCase(level)}`, []))
		const ran = yield* Effect.result(session.query(sql, []))
		if (Result.isFailure(ran)) {
			const fields = defined(pgErrorFields(ran.failure), `${sql}: a server error`)
			/** The aborted transaction's COMMIT is answered with ROLLBACK: nothing it did is committed. */
			const ended = yield* Effect.result(session.commit)
			assert.ok(Result.isFailure(ended), `${sql}: an aborted transaction does not commit`)
			return { kind: "refused", code: fields.code, table: fields.table }
		}
		if (!readOnly) {
			yield* Effect.orDie(session.rollback)
			return { kind: "ran", committed: false }
		}
		const ended = yield* Effect.result(session.commit)
		return { kind: "ran", committed: Result.isSuccess(ended) }
	})

const rowsAgree = set(ordered(exact))

layer(Substrate.isolatedLayer, { excludeTestServices: true })(
	"every write to a grizzle table runs at SERIALIZABLE",
	(it) => {
		it.effect(
			"the installation sets the database's default to SERIALIZABLE and guards every table with one statement trigger",
			() =>
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
					assert.equal(before[0]?.[0], "read committed")
					const installed = yield* install(Guarded, {
						ambient: ordinarySession,
						extensions: [],
						logins: [world.server],
						label: "guard"
					})
					const settings = yield* s.admin.queryValues(
						`SELECT unnest(setconfig)::text FROM pg_catalog.pg_db_role_setting
					WHERE setrole = 0 AND setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())`,
						[]
					)
					assert.ok(
						Arr.some(settings, ([x]) => x === "default_transaction_isolation=serializable"),
						`the database's settings: ${Arr.join(
							Arr.map(settings, ([x]) => String(x)),
							", "
						)}`
					)
					const level = yield* Effect.scoped(
						Effect.flatMap(
							s.session({ ...worldSession(installed.world(world.app)), label: "writer" }),
							(w) => w.values("SHOW transaction_isolation", [])
						)
					)
					assert.equal(level[0]?.[0], "serializable", "a new session of the writer names no level")
					/**
					 * Each table of the schema, its guard triggers, and whether each is BEFORE INSERT OR UPDATE OR DELETE OR
					 * TRUNCATE FOR EACH STATEMENT (tgtype 2 | 4 | 8 | 16 | 32, the row bit clear) and enabled.
					 */
					const guards = yield* s.admin.queryValues(
						`SELECT c.relname::text,
						count(t.oid) FILTER (WHERE t.tgname = $2::text)::int4,
						coalesce(bool_and(t.tgtype = 62 AND t.tgenabled = 'O') FILTER (WHERE t.tgname = $2::text), false)
					FROM pg_catalog.pg_class AS c
					JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
					LEFT JOIN pg_catalog.pg_trigger AS t ON t.tgrelid = c.oid
					WHERE n.nspname = $1::text AND c.relkind IN ('r', 'p')
					GROUP BY c.relname`,
						[installed.schema, identifierOf(identity.isolationTrigger())]
					)
					const authored = Arr.filter(
						guards,
						([name]) => !isLedgerObject(installed.schema, String(name))
					)
					assert.deepEqual(
						set(exact)(
							Arr.map(authored, ([name]) => String(name)),
							Arr.map(tables, (t) => identifierOf(identity.table(parsedName(t.relation))))
						),
						Option.none(),
						`the schema's tables: ${Arr.join(
							Arr.map(authored, ([name]) => String(name)),
							", "
						)}`
					)
					for (const [name, count, shaped] of guards) {
						assert.equal(Number(count), 1, `${String(name)} carries one guard trigger`)
						assert.equal(
							shaped,
							true,
							`${String(name)}'s guard is BEFORE every write, per statement, enabled`
						)
					}
				}).pipe(Effect.scoped)
		)

		it.effect(
			"a write below SERIALIZABLE is refused with 25000 naming its table, after privilege; a read is admitted",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const installed = yield* install(Guarded, {
							ambient: ordinarySession,
							extensions: [],
							logins: [world.server],
							label: "guardbox"
						})
						const q = quoteIdent(installed.schema)
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
										Arr.map(
											t.fields,
											(f) => `${quoteIdent(identifierOf(identity.column(parsedName(f))))}::text`
										),
										", "
									)} FROM ${q}.${quoteIdent(identifierOf(identity.table(parsedName(t.relation))))}`,
									[]
								),
								(rows) => Arr.map(rows, (row) => Arr.map(row, (x) => String(x)))
							)
						)
						yield* transaction(s.admin, loadState(q))
						const situations: Arr.NonEmptyReadonlyArray<IsolationFeature> = [
							"truncate: refused by privilege",
							...Arr.flatMap(writes, (w): ReadonlyArray<IsolationFeature> => [
								`${w}: admitted`,
								`${w}: refused by the guard`
							]),
							"update: refused by privilege",
							"select: admitted",
							...Arr.map(tables, (t): IsolationFeature => `${tableKind(t)}: refused by the guard`)
						]
						return yield* exhaust(
							{
								suite: "pg/direct-writers/isolation",
								generator: box,
								literal: Formatter.format,
								limit: levels.length * actors.length * statements.length * tables.length,
								coverage: requiredInSpace<IsolationFeature>(situations),
								caseHang: Duration.minutes(2)
							},
							([[level, actor, statement], table], c) =>
								Effect.gen(function* () {
									const sql = sqlOf(q, statement, table)
									const point = `${actor} at ${level}: ${sql}`
									const verdict = predict(level, actor, statement, table)
									const met = yield* runPoint(sessions[actor], level, sql, statement === "select")
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
												met.table,
												Option.some(
													identifierOf(identity.table(parsedName(verdict.table.relation)))
												),
												`${point}: the refusal names the table`
											)
											c.note(`${tableKind(table)}: refused by the guard`)
											break
									}
									c.note(`${statement}: ${verdict.kind}`)
									/** Every point ends rolled back or refused, so the state is the starting one. */
									const state = yield* Effect.orDie(readState)
									for (const [i, t] of tables.entries()) {
										assert.deepEqual(
											rowsAgree(defined(state[i], `${t.relation}'s rows`), t.rows),
											Option.none(),
											`${point}: ${t.relation} is as it started`
										)
									}
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
