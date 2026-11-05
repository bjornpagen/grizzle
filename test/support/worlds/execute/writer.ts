import { Array as Arr, Effect, Option, Record as Rec, type Scope, String as Str } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { type PgErrorFields, reportedOwnerOf } from "#test/support/substrate/errors.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import {
	advancesOf,
	type DirectNames,
	directSql,
	type Reads
} from "#test/support/worlds/execute/direct.ts"
import { valueOfText } from "#test/support/worlds/execute/host.ts"
import type { Found } from "#test/support/worlds/execute/leak.ts"
import { sqlStateOf } from "#test/support/worlds/execute/observe.ts"
import { type Seen, seen } from "#test/support/worlds/execute/session.ts"
import { fieldDomain } from "#test/support/worlds/model/host.ts"
import type {
	BaseSpec,
	DirectStatement,
	FieldDomain,
	InstalledNames,
	Observation,
	Probe,
	Witness
} from "#test/support/worlds/model/types.ts"

import { regex } from "arkregex"
/** A direct SQL writer's session: a psql child logged in as a login, inside the transaction it began. */
export interface DirectSession {
	readonly kind: "direct"
	readonly login: string
	readonly writer: PsqlWriter
	/** The backend serving it, read once when it began: it serves the session until its scope closes. */
	readonly pid: number
	/**
	 * Closing it ends the psql child and then terminates its backend (substrate.ts), which rolls back whatever is open
	 * and waits on no other session's lock.
	 */
	readonly scope: Scope.Closeable
	/** What each statement it prepared reads, by name. */
	readonly prepared: Map<string, Reads>
}

/** What the executor reads a direct writer's refusals by: the installation's laws and names. */
export interface LawReading {
	readonly base: BaseSpec
	readonly names: InstalledNames
	readonly installation: Installation
}

/** The texts of a refusal PostgreSQL raised that the leak scan reads: its message, DETAIL, HINT and CONTEXT. */
const fieldTexts = (fields: PgErrorFields): ReadonlyArray<Found> => [
	{ field: "message", text: fields.message },
	...Option.match(fields.detail, {
		onNone: () => [],
		onSome: (text): ReadonlyArray<Found> => [{ field: "detail", text }]
	}),
	...Option.match(fields.hint, {
		onNone: () => [],
		onSome: (text): ReadonlyArray<Found> => [{ field: "hint", text }]
	}),
	...Option.match(fields.where, {
		onNone: () => [],
		onSome: (text): ReadonlyArray<Found> => [{ field: "where", text }]
	})
]

/** What a report tells of a refusal PostgreSQL raised: its SQLSTATE, then its message, DETAIL, HINT and CONTEXT. */
const toldOf = (fields: PgErrorFields): ReadonlyArray<string> => [
	`code: ${fields.code}`,
	...Arr.map(fieldTexts(fields), (f) => f.text)
]

/** The field of a relation an installed column holds, read back through InstalledNames. */
const fieldOfColumn = (
	reading: LawReading,
	table: string,
	column: string
): Option.Option<readonly [string, string]> =>
	Option.flatMap(
		Arr.findFirst(Rec.toEntries(reading.names.tables), ([, t]) => t === table),
		([relation]) =>
			Option.flatMap(Rec.get(reading.names.columns, relation), (columns) =>
				Option.map(
					Arr.findFirst(Rec.toEntries(columns), ([, c]) => c === column),
					([field]) => [relation, field] as const
				)
			)
	)

const domainOf = (base: BaseSpec, relation: string, field: string): Option.Option<FieldDomain> =>
	Option.fromUndefinedOr(fieldDomain(base, { kind: "ordinary", name: relation }, field))

const keyDetail = regex("^Key \\((.+)\\)=\\((.*)\\) ")

/** A column name a DETAIL lists unquoted, at the head of `text`: up to the ", " after it, and the text from there. */
const bareColumn = (text: string): readonly [string, string] =>
	Option.match(Str.indexOf(", ")(text), {
		onNone: (): readonly [string, string] => [text, ""],
		onSome: (end): readonly [string, string] => [Str.slice(0, end)(text), Str.slice(end)(text)]
	})

/**
 * A double-quoted column name read past its opening quote, `name` holding what is read of it so far: up to its closing
 * quote, an inner quote doubled, and the text past that quote; an unclosed one runs to the end of the text.
 */
const quotedColumn = (text: string, name: string): readonly [string, string] =>
	Option.match(Str.indexOf('"')(text), {
		onNone: (): readonly [string, string] => [`${name}${text}`, ""],
		onSome: (quote): readonly [string, string] =>
			Str.startsWith('"', quote + 1)(text)
				? quotedColumn(Str.slice(quote + 2)(text), `${name}${Str.slice(0, quote + 1)(text)}`)
				: [`${name}${Str.slice(0, quote)(text)}`, Str.slice(quote + 1)(text)]
	})

/**
 * The column names a `Key (columns)=` DETAIL lists, in order, separated by ", ": an index's as quote_identifier spells
 * them (a keyword such as `user`, or a name that is not all lowercase, double-quoted, an inner quote doubled), a foreign
 * key's as they are.
 */
const detailColumns = (text: string): ReadonlyArray<string> => {
	if (Str.isEmpty(text)) {
		return []
	}
	const [name, rest] = Str.startsWith('"')(text)
		? quotedColumn(Str.slice(1)(text), "")
		: bareColumn(text)
	return [name, ...detailColumns(Str.startsWith(", ")(rest) ? Str.slice(2)(rest) : rest)]
}

/** A foreign key's DETAIL for a fact a delete or update leaves referenced: `... is still referenced from table "<t>".` */
const stillReferenced = ' is still referenced from table "'

/** The referenced table a foreign key's violation by a delete or update names in its message. */
const referencedTable = regex('^update or delete on table "(.+?)" violates foreign key constraint ')

/**
 * The table a `Key (columns)=(values)` DETAIL's columns are of: the error's own table for a key, an exclusion and a
 * reference that is not present; for a fact still referenced, the referenced table its message names, since the error
 * names the referencing table (PostgreSQL's ri_ReportViolation lists the referenced key's columns then). None when the
 * error names no table; a message that does not read back is a defect of the run.
 */
const detailTable = (
	fields: PgErrorFields,
	detail: string
): Effect.Effect<Option.Option<string>> => {
	if (!Str.includes(stillReferenced)(detail)) {
		return Effect.succeed(fields.table)
	}
	const [, referenced] = referencedTable.exec(fields.message) ?? []
	return referenced === undefined
		? Effect.die(
				new Error(
					`a foreign key violation whose message names no referenced table: ${fields.message}`
				)
			)
		: Effect.succeedSome(referenced)
}

/**
 * A native constraint's witness: PostgreSQL's `Key (columns)=(values)` DETAIL read back into the fields of the relation
 * its columns are of (detailTable), or withheld when it sent none (it omits key detail from a role that cannot read
 * the row). A DETAIL that does not read back strictly is a defect of the run.
 */
const nativeWitness = (reading: LawReading, fields: PgErrorFields): Effect.Effect<Witness> =>
	Option.match(fields.detail, {
		onNone: () => Effect.succeed({ kind: "withheld" }),
		onSome: (detail) =>
			Effect.gen(function* () {
				const match = keyDetail.exec(detail)
				const [, columnsText, valuesText] = match ?? []
				const reported = yield* detailTable(fields, detail)
				if (columnsText === undefined || valuesText === undefined || Option.isNone(reported)) {
					return { kind: "withheld" }
				}
				const table = reported.value
				const columns = detailColumns(columnsText)
				const values = Str.split(valuesText, ", ")
				if (columns.length !== values.length) {
					return yield* Effect.die(new Error(`a DETAIL whose keys do not read back: ${detail}`))
				}
				const entries = yield* Effect.forEach(columns, (column, i) =>
					Effect.gen(function* () {
						const named = fieldOfColumn(reading, table, column)
						const text = values[i]
						if (Option.isNone(named) || text === undefined) {
							return yield* Effect.die(
								new Error(`a DETAIL naming ${table}.${column}, which no field holds`)
							)
						}
						const [relation, field] = named.value
						const domain = domainOf(reading.base, relation, field)
						if (Option.isNone(domain)) {
							return yield* Effect.die(new Error(`no domain for ${relation}.${field}`))
						}
						return [field, yield* valueOfText(domain.value, text, `${relation}.${field}`)] as const
					})
				)
				const witness: Witness = { kind: "shown", keys: [Rec.fromEntries(entries)] }
				return witness
			})
	})

/**
 * The law a direct writer's refusal names: a native constraint's under the table or domain PostgreSQL reports it on.
 * Every law is native (fin.md §7), so a constraint beside no owner names none.
 */
const reportedLaw = (
	installation: Installation,
	fields: PgErrorFields,
	constraint: ConstraintName
): LawId | undefined => {
	const owner = reportedOwnerOf(fields)
	return owner === undefined
		? undefined
		: constraintLaw(installation.constraintToLaw, owner, constraint)
}

/** A direct writer's refusal: a law's, with its identity and witness, or PostgreSQL's SQLSTATE alone. */
const refusalOf = (reading: LawReading, fields: PgErrorFields): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const sqlstate = sqlStateOf(fields.code)
		const law =
			fields.constraint === undefined
				? undefined
				: reportedLaw(reading.installation, fields, fields.constraint)
		if (law === undefined) {
			return {
				observation: { kind: "refused", sqlstate },
				found: fieldTexts(fields),
				told: toldOf(fields)
			}
		}
		const witness = yield* nativeWitness(reading, fields)
		const observation: Observation = { kind: "law-refused", sqlstate, law, witness }
		return { observation, found: fieldTexts(fields), told: toldOf(fields) }
	})

/**
 * One direct statement on the writer's session, as the README's writer sends it: the statement, then, once it
 * succeeded, the advance calls it owes (direct.ts advancesOf), the first refused one's refusal being the statement's.
 */
export const runDirect = (
	reading: LawReading,
	names: DirectNames,
	session: DirectSession,
	statement: DirectStatement
): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const ran = yield* runOne(reading, names, session, statement)
		if (ran.observation.kind !== "ok" && ran.observation.kind !== "rows") {
			return ran
		}
		const found: Array<Found> = [...ran.found]
		for (const advance of yield* advancesOf(names, statement)) {
			const advanced = yield* runOne(reading, names, session, advance)
			appendAll(found, advanced.found)
			if (advanced.observation.kind !== "ok") {
				return { ...advanced, found }
			}
		}
		return { ...ran, found }
	})

/** One statement's SQL on the writer's session, and what it answered. */
const runOne = (
	reading: LawReading,
	names: DirectNames,
	session: DirectSession,
	statement: DirectStatement
): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		const direct = yield* directSql(names, session.prepared, statement)
		const ran = yield* Effect.result(session.writer.run(direct.sql))
		if (ran._tag === "Failure") {
			const error = ran.failure
			return error._tag === "PsqlStatementError"
				? yield* refusalOf(reading, error.fields)
				: yield* Effect.die(error)
		}
		const notices = Arr.map(ran.success.notices, (text): Found => ({ field: "notice", text }))
		const reads = direct.reads
		if (reads.kind === "none") {
			return { observation: { kind: "ok" }, found: notices, told: [] }
		}
		const rows = yield* Effect.forEach(ran.success.rows, (row, r) =>
			Effect.map(
				Effect.forEach(reads.fields, (f, i) => {
					const text = row[i]
					return text === undefined || text === null
						? Effect.die(new Error(`a direct read's row ${r} holds no ${f.field}`))
						: Effect.map(valueOfText(f.domain, text, f.field), (value) => [f.field, value] as const)
				}),
				Rec.fromEntries
			)
		)
		return { observation: { kind: "rows", rows }, found: notices, told: [] }
	})

/** The end of a direct writer's transaction: COMMIT judges the deferred laws; COMMIT of an aborted one rolls it back. */
export const endDirect = (
	reading: LawReading,
	session: DirectSession,
	end: "commit" | "rollback"
): Effect.Effect<Seen> =>
	Effect.gen(function* () {
		if (end === "rollback") {
			yield* Effect.orDie(session.writer.rollback)
			return seen({ kind: "ok" })
		}
		const committed = yield* Effect.result(session.writer.commit)
		if (committed._tag === "Success") {
			return seen({ kind: "ok" })
		}
		const error = committed.failure
		switch (error._tag) {
			case "TransactionRolledBack":
				return seen({ kind: "ok" })
			case "PsqlStatementError":
				return yield* refusalOf(reading, error.fields)
			case "PsqlProcessError":
				return yield* Effect.die(error)
		}
	})

/**
 * current_user, the claims setting and whether the statement runs inside an explicit transaction: the probe of a direct
 * writer's connection and of a pooled one (pool.ts probePool).
 */
export const probeSql =
	"SELECT current_user::text, coalesce(pg_catalog.current_setting('grizzle.claims', true), ''), pg_catalog.statement_timestamp() <> pg_catalog.transaction_timestamp()"

/**
 * What a direct writer's connection carries: an aborted transaction refuses the read (25P02); otherwise the read runs
 * inside the explicit transaction exactly when its statement began after the transaction did (the two timestamps are
 * equal only on the first command of an implicit transaction).
 */
export const probeDirect = (session: DirectSession): Effect.Effect<Probe> =>
	Effect.gen(function* () {
		const read = yield* Effect.result(session.writer.run(probeSql))
		if (read._tag === "Failure") {
			const error = read.failure
			return error._tag === "PsqlStatementError" && error.fields.code === "25P02"
				? { transaction: "aborted" }
				: yield* Effect.die(error)
		}
		const [row] = read.success.rows
		const [user, claims, inside] = row ?? []
		if (user === undefined || user === null || claims === undefined || claims === null) {
			return yield* Effect.die(new Error("the probe read no row"))
		}
		return { transaction: inside === "t" ? "in-transaction" : "idle", currentUser: user, claims }
	})
