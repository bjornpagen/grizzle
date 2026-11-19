import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { exact, ordered, set, structuralHash } from "@bjornpagen/testing/oracle"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result, String as Str } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { pg } from "#compiler/public/fields.ts"
import { check, contained, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, installMigrated, seededTemplate } from "#test/support/install-migrate.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { type RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

const Team = relation("Team", { id: pg.integer, cap: pg.integer, name: pg.integer }, ["id"])
const Member = relation("Member", { id: pg.integer, team: pg.integer, active: pg.boolean }, ["id"])
const Note = relation("Note", { id: pg.integer, body: pg.integer }, ["id"])
const Tag = relation("Tag", { id: pg.integer, body: pg.integer }, ["id"])

const Guarded = schema(
	"Guarded",
	[Team, Member, Note, Tag],
	[
		check("CapNotNegative", Team, (x) => x.ge(x.cap, 0)),
		contained(on(Member, "team"), on(Team, "id")),
		mutable(Team),
		mutable(Tag)
	]
)

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
export type Point = readonly [readonly [Level, Actor, Statement], Table, boolean]

export const box: Gen<Point> = (source) => {
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

export type IsolationFeature =
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

/** Every situation the box reaches (requiredInSpace before it), each statement's verdicts and each kind of table's. */
export const situations: Arr.NonEmptyReadonlyArray<IsolationFeature> = [
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

/**
 * Guarded installed through its generated migration with its full world and its starting state loaded, once per member
 * (install-migrate.ts seededTemplate), where the search installed and loaded it before its points: each point's
 * transaction rolls back, so the seat empties nothing; its database's default is the one the installation set, which
 * every clone of the template takes (substrate.ts installTemplate). That the installation sets it is
 * theInstallationSetsTheDatabasesDefaultToSerializable's.
 */
export const guardedTemplate = seededTemplate({
	declaredIn: import.meta,
	name: "guard box",
	schema: Guarded,
	options: { ambient: ordinarySession, extensions: [], logins: [world.server], label: "guardbox" },
	seed: (installed) =>
		Effect.flatMap(Substrate, (s) => transaction(s.admin, loadState(namesOf(installed))))
})

/**
 * A point of the box over the case's clone of Guarded (`installed`): its transaction run by its actor at its level, its
 * outcome held to the README's refusal order (predict), and its tables as they started.
 */
export const pointCase = (installed: Installed, drawn: Point, c: Case<IsolationFeature>) =>
	Effect.gen(function* () {
		const [[level, actor, statement], table, readFirst] = drawn
		const s = yield* Substrate
		const names = namesOf(installed)
		const sessions: Readonly<Record<Actor, RawSession>> = {
			writer: yield* s.session({ ...worldSession(installed.world(world.app)), label: "writer" }),
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
		const sql = sqlOf(names, statement, table)
		const reads = readFirst ? [sqlOf(names, "select", table)] : []
		const point = `${actor} at ${level}: ${Arr.join([...reads, sql], "; ")}`
		const verdict = predict(level, actor, statement, table)
		const met = yield* runPoint(sessions[actor], level, reads, sql, statement === "select")
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
					[Option.some(names.schema), Option.some(names.tableIdent(verdict.table.relation))],
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

/** The default levels a database may name before the installation: none (PostgreSQL's own), or any below SERIALIZABLE. */
export const priorDefaults: Gen<
	"none" | "read committed" | "repeatable read" | "read uncommitted"
> = (source) =>
	source.draw(element(["none", "read committed", "repeatable read", "read uncommitted"] as const))

/**
 * The case's own database left at `prior` (RESET where it names none), its new sessions reading it, then Guarded
 * installed: its new sessions read SERIALIZABLE, the default the installation set.
 */
export const installedDefault = (
	prior: "none" | "read committed" | "repeatable read" | "read uncommitted"
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		yield* s.admin.query(
			prior === "none"
				? `ALTER DATABASE ${quoteIdent(s.database)} RESET default_transaction_isolation`
				: `ALTER DATABASE ${quoteIdent(s.database)} SET default_transaction_isolation = '${prior}'`,
			[]
		)
		const shown = (label: string) =>
			Effect.scoped(
				Effect.flatMap(s.session({ ...ownerSession(), label }), (o) =>
					o.values("SHOW default_transaction_isolation", [])
				)
			)
		const before = yield* shown("before")
		assert.equal(before[0]?.[0], prior === "none" ? "read committed" : prior, "the planted premise")
		yield* installMigrated(Guarded, {
			ambient: ordinarySession,
			extensions: [],
			logins: [world.server],
			label: "guardbox"
		})
		const after = yield* shown("after")
		assert.equal(after[0]?.[0], "serializable", "the default the installation set")
	})
