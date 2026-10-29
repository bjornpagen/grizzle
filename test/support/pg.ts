import { Buffer } from "node:buffer"
import { connect as netConnect } from "node:net"
import { checkServerIdentity, type PeerCertificate, connect as tlsConnect } from "node:tls"
import {
	Array as Arr,
	Clock,
	DateTime,
	Effect,
	Function,
	Option,
	pipe,
	Predicate,
	Redacted,
	Schema,
	type Scope,
	Semaphore,
	String as Str
} from "effect"
import { Client, DatabaseError } from "pg"
import { nameSchemas } from "#adapter/boundary/names.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { connectSession, type Session } from "#adapter/wire/session.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { decodeJson } from "#test/support/json.ts"
import { randomHex } from "#test/support/substrate/names.ts"

import { regex } from "arkregex"
/**
 * The fields of a PostgreSQL ErrorResponse that tests assert on: `code` is the SQLSTATE; the fields PostgreSQL may omit
 * are decoded once, none where it sent none; `where` is the CONTEXT lines, where in a function or trigger the error was
 * raised; `dataType` is the data type it reported, a domain constraint's domain; and `constraint` is the one PostgreSQL
 * reported, admitted at this decode boundary (adapter/boundary/names.ts nameSchemas), or none.
 */
export const PgErrorFieldsSchema = Schema.Struct({
	code: Schema.String,
	message: Schema.String,
	detail: Schema.Option(Schema.String),
	hint: Schema.Option(Schema.String),
	where: Schema.Option(Schema.String),
	schema: Schema.Option(Schema.String),
	table: Schema.Option(Schema.String),
	column: Schema.Option(Schema.String),
	dataType: Schema.Option(Schema.String),
	constraint: Schema.UndefinedOr(nameSchemas.constraint)
})

/**
 * Sessions and test databases on the local cluster, over verify-full TLS as the adapter connects.
 *
 * A test connection is a direct SQL client, not grizzle: a pg Client of its own, every statement on the extended
 * protocol and unnamed, one at a time. Its values are parsed for a test to read: booleans,
 * integers (int8 as bigint), floats, JSON, timestamps (as Date), intervals (months, days and microseconds), byte
 * strings and arrays of them; every other type, numeric, uuid, date, time and every user type among them, as its text.
 *
 * Concurrent statements on one connection take turns, one statement at a time; `pin` holds the connection for a scope,
 * so a transaction's statements are not interleaved with another fiber's. An interrupted statement is cancelled with
 * CancelRequests over a TLS connection of their own until it ends, so the connection is usable again.
 *
 * Test databases are created here and never dropped here. Nothing in test/ issues DROP DATABASE but the sweep
 * (test/support/substrate/shared.ts), which runs only when no test file of its caller runs: DROP DATABASE holds its
 * transaction id through the checkpoint it forces, which pins every SERIALIZABLE snapshot's xmin meanwhile and makes
 * PostgreSQL summarize every other file's committed transactions (freshDatabase below).
 *
 * A test connection's statement failed: PostgreSQL refused it (its ErrorResponse fields), or the connection failed.
 */
export class SqlError extends Schema.TaggedError<SqlError, { readonly brand: unique symbol }>()(
	"SqlError",
	{
		reason: Schema.Union([
			Schema.TaggedStruct("ServerError", { fields: PgErrorFieldsSchema }),
			Schema.TaggedStruct("ConnectionError", { message: Schema.String })
		]),
		/** What the driver raised. */
		cause: Schema.Unknown
	}
) {}

export interface RawQueryResult {
	readonly command: string
	readonly rowCount: number
	readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
	/** The result's columns, in order: each one's name and type OID. */
	readonly fields: ReadonlyArray<{ readonly name: string; readonly dataTypeId: number }>
}

export interface PgConnection {
	/** The backend's process id, from the connection's BackendKeyData. */
	readonly processId: number
	/** One unnamed statement; its rows as records by column name. */
	readonly query: (
		sql: string,
		params: ReadonlyArray<unknown>
	) => Effect.Effect<RawQueryResult, SqlError>
	/** One unnamed statement; its rows positional. */
	readonly queryValues: (
		sql: string,
		params: ReadonlyArray<unknown>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
	/** The connection for the scope alone. */
	readonly pin: Effect.Effect<PgConnection, never, Scope.Scope>
}

/**
 * A test-support connection's login: the database, the login role and its password, and the application name the
 * server records, if any. Every one reaches the cluster at the pin's host and port over verify-full TLS, the server's
 * certificate chained to the initialised cluster's CA and naming the host.
 */
interface SessionOptions {
	readonly database: string
	readonly username: string
	readonly password: Redacted.Redacted
	readonly applicationName: Option.Option<string>
}

/**
 * A session as the migration identity grizzle_dev in its own database, with the application name the server records,
 * if any.
 */
export const devSession = (
	cluster: InitializedClusterShape,
	applicationName: Option.Option<string>
): Effect.Effect<PgConnection, SqlError, Scope.Scope> =>
	session(cluster, {
		database: pgPin.devRole,
		username: pgPin.devRole,
		password: cluster.devPassword,
		applicationName
	})

/** The text of each type a test reads as a value, by type OID. */
const hexBytes = (text: string): Uint8Array =>
	new Uint8Array(Buffer.from(Str.slice(2)(text), "hex"))

/** An interval's text in the postgres IntervalStyle: years, mons, days, and a time of day, each optional and signed. */
const intervalOf = (text: string) => {
	let months = 0
	let days = 0
	let microseconds = 0n
	const parts = Str.split(text, " ")
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] ?? ""
		if (Str.includes(":")(part)) {
			const negative = Str.startsWith("-")(part)
			const [h, m = "0", s = "0"] = Str.split(
				negative || Str.startsWith("+")(part) ? Str.slice(1)(part) : part,
				":"
			)
			const [whole, fraction = ""] = Str.split(s, ".")
			const micros =
				(BigInt(h) * 3600n + BigInt(m) * 60n + BigInt(whole)) * 1_000_000n +
				BigInt(pipe(Str.padEnd(6, "0")(fraction), Str.slice(0, 6)))
			microseconds += negative ? -micros : micros
			continue
		}
		const amount = Number(part)
		const unit = parts[++i] ?? ""
		if (Str.startsWith("year")(unit)) {
			months += amount * 12
		} else if (Str.startsWith("mon")(unit)) {
			months += amount
		} else if (Str.startsWith("day")(unit)) {
			days += amount
		}
	}
	return { months, days, microseconds }
}

/** A json or jsonb column's text as the JSON value it holds, for a test to read with a schema of its own. */
const jsonValue = decodeJson(Schema.Unknown)

const scalarParsers: ReadonlyMap<number, (text: string) => unknown> = new Map<
	number,
	(text: string) => unknown
>([
	[16, (t) => t === "t"],
	[17, hexBytes],
	[20, (t) => BigInt(t)],
	[21, Number],
	[23, Number],
	[26, Number],
	[700, Number],
	[701, Number],
	[114, jsonValue],
	[3802, jsonValue],
	[1114, (t) => DateTime.toDateUtc(DateTime.makeUnsafe(`${Str.replace(" ", "T")(t)}Z`))],
	[
		1184,
		(t) =>
			DateTime.toDateUtc(
				DateTime.makeUnsafe(
					pipe(Str.replace(" ", "T")(t), Str.replace(regex("([+-]\\d\\d)$"), "$1:00"))
				)
			)
	],
	[1186, intervalOf]
])

/** An array literal's elements, NULL as null, nested arrays as arrays. */
const parseArray = (text: string, element: (text: string) => unknown): unknown => {
	let at = Str.startsWith("[")(text)
		? Str.indexOf("=")(text).pipe(
				Option.map((i) => i + 1),
				Option.getOrElse(() => 0)
			)
		: 0
	const parse = (): Array<unknown> => {
		const out: Array<unknown> = []
		at++
		while (at < text.length && text[at] !== "}") {
			if (text[at] === ",") {
				at++
				continue
			}
			if (text[at] === "{") {
				out.push(parse())
				continue
			}
			if (text[at] === '"') {
				let value = ""
				at++
				while (text[at] !== '"') {
					if (text[at] === "\\") {
						at++
					}
					value += text[at]
					at++
				}
				at++
				out.push(element(value))
				continue
			}
			const end = Arr.flatMap([",", "}"], (c) =>
				Str.indexOf(c)(Str.slice(at)(text)).pipe(
					Option.map((i) => i + at),
					Option.toArray
				)
			)
			const stop = Math.min(...end)
			const raw = Str.slice(at, stop)(text)
			out.push(raw === "NULL" ? null : element(raw))
			at = stop
		}
		at++
		return out
	}
	return parse()
}

const arrayElements: ReadonlyMap<number, number> = new Map([
	[1000, 16],
	[1001, 17],
	[1005, 21],
	[1007, 23],
	[1016, 20],
	[1028, 26],
	[1021, 700],
	[1022, 701],
	[199, 114],
	[3807, 3802],
	[1115, 1114],
	[1185, 1184],
	[1187, 1186],
	[1009, 25],
	[1015, 25],
	[1014, 25],
	[1003, 25],
	[1231, 25],
	[2951, 25],
	[1182, 25],
	[1183, 25],
	[1270, 25],
	[1041, 25],
	[651, 25]
])

const identity = (text: string): string => text

const parserOf = (oid: number): ((text: string) => unknown) => {
	const scalar = scalarParsers.get(oid)
	if (scalar !== undefined) {
		return scalar
	}
	const element = arrayElements.get(oid)
	if (element === undefined) {
		return identity
	}
	const parseElement = scalarParsers.get(element) ?? identity
	return (text) => parseArray(text, parseElement)
}

const types = { getTypeParser: parserOf } as const

/** A value bound as a parameter's text. */
const textOf = (value: unknown): unknown => {
	if (typeof value === "bigint") {
		return value.toString()
	}
	if (Arr.isArray(value)) {
		return Arr.map(value, textOf)
	}
	return value
}

/**
 * The constraint an ErrorResponse reported: a non-empty name, admitted at this boundary (adapter/boundary/names.ts
 * nameSchemas), or none. The test connection's errors, a psql child's verbose report and a recorded error all read it here.
 */
export const reportedConstraintOf = (value: unknown): ConstraintName | undefined =>
	Predicate.isString(value) && value.length > 0
		? Option.getOrUndefined(Schema.decodeOption(nameSchemas.constraint)(value))
		: undefined

/** The SqlError of a failed statement. */
const sqlErrorOf = (error: unknown): SqlError => {
	if (error instanceof DatabaseError && error.code !== undefined) {
		return SqlError.make({
			reason: {
				_tag: "ServerError",
				fields: {
					code: error.code,
					message: error.message,
					detail: Option.fromUndefinedOr(error.detail),
					hint: Option.fromUndefinedOr(error.hint),
					where: Option.fromUndefinedOr(error.where),
					schema: Option.fromUndefinedOr(error.schema),
					table: Option.fromUndefinedOr(error.table),
					column: Option.fromUndefinedOr(error.column),
					dataType: Option.fromUndefinedOr(error.dataType),
					constraint: reportedConstraintOf(error.constraint)
				}
			},
			cause: error
		})
	}
	return SqlError.make({
		reason: {
			_tag: "ConnectionError",
			message: Error.isError(error) ? error.message : String(error)
		},
		cause: error
	})
}

interface Target {
	readonly host: string
	readonly port: number
	readonly ca: string
	readonly servername: string
}

/**
 * One CancelRequest for the backend's running statement, over a TLS connection of its own. It ends when the server
 * closes that connection, or after a second.
 */
const cancelRequest = (target: Target, processId: number, secretKey: number): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		const frame = Buffer.alloc(16)
		frame.writeInt32BE(16, 0)
		frame.writeInt32BE(80877102, 4)
		frame.writeInt32BE(processId, 8)
		frame.writeInt32BE(secretKey, 12)
		const raw = netConnect({ host: target.host, port: target.port })
		let finished = false
		const finish = (): void => {
			if (finished) {
				return
			}
			finished = true
			raw.destroy()
			resume(Effect.void)
		}
		raw.once("error", finish)
		raw.once("close", finish)
		raw.once("connect", () => raw.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])))
		raw.once("data", () => {
			const secure = tlsConnect({ socket: raw, ca: target.ca, servername: target.servername })
			secure.once("error", finish)
			secure.once("close", finish)
			secure.once("secureConnect", () => secure.write(frame))
		})
		return Effect.sync(finish)
	}).pipe(Effect.timeoutOption("1 second"), Effect.asVoid)

/** What pg answers a statement: its command tag, row count and rows. */
interface Answered {
	readonly command: string
	readonly rowCount: number | null
	readonly rows: Array<unknown>
	readonly fields: ReadonlyArray<{ readonly name: string; readonly dataTypeID: number }>
}

/**
 * An unnamed statement on the extended protocol. pg sends a statement without parameters as a simple Query message,
 * which accepts several statements in one text, unless its `queryMode` is "extended", which pg's types leave out.
 */
const queryOf = (sql: string, params: ReadonlyArray<unknown>, rowMode: "array" | "object") => ({
	text: sql,
	values: Arr.map(params, textOf),
	queryMode: "extended" as const,
	...(rowMode === "array" ? { rowMode: "array" as const } : {})
})

const numberOf = (client: Client, field: string): number => {
	const value: unknown = Reflect.get(client, field)
	return Predicate.isNumber(value) ? value : 0
}

const connectOnce = (
	ca: string,
	options: SessionOptions
): Effect.Effect<PgConnection, SqlError, Scope.Scope> =>
	Effect.gen(function* () {
		const target: Target = { host: pgPin.host, port: pgPin.port, ca, servername: pgPin.host }
		const client = new Client({
			host: target.host,
			port: target.port,
			database: options.database,
			user: options.username,
			password: Redacted.value(options.password),
			...Option.match(options.applicationName, {
				onNone: () => ({}),
				onSome: (name) => ({ application_name: name })
			}),
			/** pg sets the SNI to the host whenever the host is a name, so the name verified is checked explicitly. */
			ssl: {
				ca: target.ca,
				servername: target.servername,
				rejectUnauthorized: true,
				checkServerIdentity: (...[, certificate]: readonly [string, PeerCertificate]) =>
					checkServerIdentity(target.servername, certificate)
			},
			types
		})
		/** The FATAL report a server sends before it ends the session, which the next statement fails with. */
		let ended = Option.none<DatabaseError>()
		client.on("error", (error: unknown) => {
			if (error instanceof DatabaseError) {
				ended = Option.some(error)
			}
		})
		yield* Effect.acquireRelease(
			Effect.callback<void, SqlError>((resume) => {
				client.connect((error: unknown) => {
					resume(
						error === null || error === undefined ? Effect.void : Effect.fail(sqlErrorOf(error))
					)
				})
				return Effect.sync(() => client.connection.stream.destroy())
			}),
			() => Effect.ignore(Effect.tryPromise(() => client.end()))
		)
		const processId = numberOf(client, "processID")
		const secretKey = numberOf(client, "secretKey")
		const turn = yield* Semaphore.make(1)
		/**
		 * One statement, cancelled until it ends when interrupted. The cancelling runs on the live clock, whatever Clock
		 * its caller runs under: a suite's TestClock never advances on its own, and an interruption, a hang guard's or a
		 * test's abort, must end once the statement has.
		 */
		const run = <R>(
			sql: string,
			params: ReadonlyArray<unknown>,
			rowMode: "array" | "object",
			read: (result: Answered) => R
		) =>
			Effect.callback<R, SqlError>((resume) => {
				let finished = false
				client.query(queryOf(sql, params, rowMode), (error: unknown, result: Answered) => {
					finished = true
					resume(
						error === null || error === undefined
							? Effect.succeed(read(result))
							: Effect.fail(
									sqlErrorOf(
										error instanceof DatabaseError || Option.isNone(ended) ? error : ended.value
									)
								)
					)
				})
				return Effect.whileLoop({
					while: () => !finished,
					body: () =>
						Effect.andThen(cancelRequest(target, processId, secretKey), Effect.sleep("50 millis")),
					step: Function.constVoid
				}).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()))
			})
		const query = (sql: string, params: ReadonlyArray<unknown>) =>
			run(sql, params, "object", (result) => ({
				command: result.command,
				rowCount: result.rowCount ?? 0,
				rows: Arr.filter(result.rows, Predicate.isObject),
				fields: Arr.map(result.fields, (f) => ({ name: f.name, dataTypeId: f.dataTypeID }))
			}))
		const queryValues = (sql: string, params: ReadonlyArray<unknown>) =>
			run(sql, params, "array", (result) =>
				Arr.filter(result.rows, (row): row is Array<unknown> => Arr.isArray(row))
			)
		/** The connection as a pinned scope holds it: its statements take no turn, and pinning it again is itself. */
		const pinned: PgConnection = {
			processId,
			query,
			queryValues,
			pin: Effect.sync(() => pinned)
		}
		return {
			processId,
			query: (sql, params) => turn.withPermit(query(sql, params)),
			queryValues: (sql, params) => turn.withPermit(queryValues(sql, params)),
			pin: Effect.as(
				Effect.acquireRelease(turn.take(1), () => turn.release(1)),
				pinned
			)
		} satisfies PgConnection
	})

/**
 * The one verify-full connection every test helper opens, the raw sessions of the substrate included: the server
 * certificate must chain to the cluster's CA and name the host.
 * It has no connect deadline of its own: a connect is judged by what the server answers, and the cluster-wide
 * connection lease (substrate/shared.ts) keeps the cluster from being loaded past its connections.
 */
export const session = (
	cluster: InitializedClusterShape,
	options: SessionOptions
): Effect.Effect<PgConnection, SqlError, Scope.Scope> => connectOnce(cluster.caPem, options)

/** A wire session's connection: a test-support connection whose application name the adapter always sends. */
interface WireSessionOptions extends Omit<SessionOptions, "applicationName"> {
	readonly applicationName: string
}

/**
 * A session of the adapter's own wire, for `grizzle migrate`'s runner (packages/grizzle/src/adapter/migrate/session.ts), closed with the
 * scope: its statements unnamed, as the command line's are. The adapter's connect budget is the production one, so an
 * attempt that fails at the connect stage, a timeout in a loaded shared test process among them, is made again, twice
 * at most.
 */
export const wireSession = (
	cluster: InitializedClusterShape,
	options: WireSessionOptions
): Effect.Effect<Session, SqlError, Scope.Scope> => {
	const attempt = connectSession({
		host: pgPin.host,
		port: pgPin.port,
		database: options.database,
		role: options.username,
		password: options.password,
		transport: { _tag: "tls", tls: { ca: cluster.caPem, servername: pgPin.host } },
		applicationName: options.applicationName
	})
	const retried = (retries: number): typeof attempt =>
		Effect.catchIf(
			attempt,
			(failure) => retries > 0 && OpenError.make({ reason: failure }).stage === "connect",
			() => retried(retries - 1)
		)
	return Effect.mapError(retried(2), (failure) =>
		SqlError.make({ reason: { _tag: "ConnectionError", message: failure.message }, cause: failure })
	)
}

/** The fields of a failure's ErrorResponse, if PostgreSQL refused the statement. */
const codeOf = (error: SqlError): string | undefined =>
	error.reason._tag === "ServerError" ? error.reason.fields.code : undefined

/**
 * The settings every test database runs with, as database-level defaults (a clone does not copy its template's):
 * - a low deadlock_timeout, so the concurrency driver's wait for each blocked step's deadlock check is short
 *   (test/support/schedules/interleave.ts). It is superuser-only; the owner holds SET on it (scripts/pg/init.sh);
 * - SERIALIZABLE as every transaction's default, the only level at which grizzle admits a write, so a plain client's
 *   seeding and resets are admitted.
 * substrate/shared.ts `leftovers` treats exactly these, and nothing else, as a test database's own settings.
 */
export const testDatabaseSettings: ReadonlyArray<readonly [name: string, value: string]> = [
	["deadlock_timeout", "10ms"],
	["default_transaction_isolation", "serializable"]
]

/** Gives database `name` the test database settings, on `admin`. */
const configureDatabase = (admin: PgConnection, name: string): Effect.Effect<void, SqlError> =>
	Effect.forEach(
		testDatabaseSettings,
		([setting, value]) => admin.query(`ALTER DATABASE "${name}" SET ${setting} TO '${value}'`, []),
		{ discard: true }
	)

/**
 * Creates `name` from the template unless it exists, and gives it the test database settings either way. Two workers
 * may race to create it: the loser's 42P04 (duplicate_database) means the database is there.
 */
export const ensureDatabase = (cluster: InitializedClusterShape, name: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const admin = yield* devSession(cluster, Option.none())
			const exists = yield* admin.queryValues(
				"SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1::text",
				[name]
			)
			if (exists.length === 0) {
				yield* admin
					.query(`CREATE DATABASE "${name}" TEMPLATE "${pgPin.templateDatabase}"`, [])
					.pipe(
						Effect.catchIf(
							(error) => codeOf(error) === "42P04",
							() => Effect.void
						)
					)
			}
			yield* configureDatabase(admin, name)
		})
	)

/**
 * A fresh database cloned from the template, which nothing here drops: a database is dropped only by the sweep
 * (test/support/substrate/shared.ts), once no test file of the process that made it runs. DROP DATABASE holds its
 * transaction id while it waits for the checkpoint it forces, seconds under a run's load; every SERIALIZABLE
 * transaction that starts meanwhile takes a snapshot whose xmin is at most that id, so SSI keeps every committed one,
 * summarizes them past its table's size, and the other files' writes fail with 40001
 * (test/support/substrate/replace.ts). CREATE DATABASE, WAL-logged, forces no checkpoint. The name carries 64 random
 * bits, which keep a process's databases apart and a reused process id's, and its pid in decimal, so the sweep can tell
 * whose it is.
 */
export const freshDatabase = (cluster: InitializedClusterShape): Effect.Effect<string, SqlError> =>
	Effect.scoped(
		Effect.gen(function* () {
			const admin = yield* devSession(cluster, Option.none())
			const name = `gz_t_${process.pid}_${randomHex(8)}`
			yield* admin.query(`CREATE DATABASE "${name}" TEMPLATE "${pgPin.templateDatabase}"`, [])
			yield* configureDatabase(admin, name)
			return name
		})
	)
