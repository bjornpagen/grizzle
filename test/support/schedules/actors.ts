import { Array as Arr, Effect, Formatter, Option, Predicate, Record, type Scope } from "effect"
import type { SessionPool } from "#adapter/wire/session.ts"
import { rowsOn } from "#test/pg/adapter/support.ts"
import { defined } from "#test/support/assert.ts"
import { ownPidOf, ownPidQuery } from "#test/support/kernel/sanitize.ts"
import type { RawQueryResult, SqlError } from "#test/support/pg.ts"
import type { DirectAction, ScheduleOutcome } from "#test/support/schedules/types.ts"
import {
	type PsqlProcessError,
	pgErrorFields,
	TransactionRolledBack
} from "#test/support/substrate/errors.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import type {
	BelowSerializable,
	Credentials,
	RawSession,
	SubstrateWorld
} from "#test/support/substrate/session.ts"

import {
	rolePsql,
	roleSession,
	type SubstrateShape,
	type TextRows,
	worldPsql,
	worldSession
} from "#test/support/substrate/substrate.ts"

/** A direct SQL writer's session: a pinned raw session or a psql child, logged in as `role`. */
export interface DirectActor {
	readonly name: string
	readonly role: string
	/** The backend running its statements, as the session read its own when it opened. */
	readonly pid: number
	/** Runs one action. Every failure is an outcome; a defect stays a defect. */
	readonly perform: (action: DirectAction) => Effect.Effect<ScheduleOutcome>
}

/**
 * A grizzle writer: its steps are operations the runner (or the explorer) runs itself; the lock barrier watches `pid`.
 */
export interface GrizzleActor {
	readonly name: string
	readonly role: string
	/**
	 * The backend of the one session its Db's pool holds, as that session answered pg_backend_pid() when the actor was
	 * named (grizzleActor): its pool takes it back idle for each later call, one at a time.
	 */
	readonly pid: number
}

/**
 * Actors: the sessions a schedule's steps run on, by kind.
 *
 * A direct actor performs one SQL step at a time and reports the backend running its statements, which the lock barrier
 * watches: a raw actor is a pinned PgConnection session and a psql actor a psql child process, both direct SQL writers
 * logged in as a role. A grizzle actor runs no SQL of its own: its steps are operations, such as a db.apply, that the
 * runner (or the explorer) runs itself, and its pid is the backend of the one session its Db's pool holds, as that
 * session answers it.
 *
 * The actors of a schedule, by session name and kind.
 */
export type Actors<D extends string, G extends string> = {
	readonly direct: { readonly [K in D]: DirectActor }
	readonly grizzle: { readonly [K in G]: GrizzleActor }
}

/**
 * A value as text, as psql prints it. Raw sessions decode values; a schedule that compares rows casts them in its SQL,
 * so only the scalar decodings reach this, and anything else is a defect of the schedule.
 */
export const textOfValue = (value: unknown): string | null => {
	if (value === null) {
		return null
	}
	if (Predicate.isString(value)) {
		return value
	}
	if (Predicate.isBoolean(value)) {
		return value ? "t" : "f"
	}
	if (Predicate.isNumber(value) || Predicate.isBigInt(value)) {
		return String(value)
	}
	throw new Error(
		`a schedule compares only cast scalars; alias and cast in the SQL: ${Formatter.format(value)}`
	)
}

/** The outcome of a failure: a PostgreSQL error, a COMMIT that rolled back, or another failure. */
export const failureOutcome = (error: unknown): ScheduleOutcome => {
	if (error instanceof TransactionRolledBack) {
		return { _tag: "RolledBack", command: error.command }
	}
	const fields = pgErrorFields(error)
	if (fields !== undefined) {
		return { _tag: "PgError", fields }
	}
	return { _tag: "Failed", error }
}

const settle = <E>(effect: Effect.Effect<ScheduleOutcome, E>): Effect.Effect<ScheduleOutcome> =>
	Effect.catch(effect, (error) => Effect.succeed(failureOutcome(error)))

const done: ScheduleOutcome = { _tag: "Ok", rows: [], rowCount: 0 }

interface ActorParts<E> {
	readonly name: string
	readonly role: string
	readonly pid: number
	readonly sql: (
		sql: string
	) => Effect.Effect<{ readonly rows: TextRows; readonly rowCount: number }, E>
	readonly begin: Effect.Effect<void, E>
	readonly beginBelow: (level: BelowSerializable) => Effect.Effect<void, E>
	readonly commit: Effect.Effect<void, E | TransactionRolledBack>
	readonly rollback: Effect.Effect<void, E>
}

/** A direct actor from its statement primitives. */
const directActor = <E>(parts: ActorParts<E>): DirectActor => ({
	name: parts.name,
	role: parts.role,
	pid: parts.pid,
	perform: (action) => {
		switch (action._tag) {
			case "Sql":
				return settle(
					Effect.map(parts.sql(action.sql), (result): ScheduleOutcome => ({
						_tag: "Ok",
						...result
					}))
				)
			case "Begin":
				return settle(Effect.as(parts.begin, done))
			case "BeginAs":
				return settle(Effect.as(parts.sql(action.sql), done))
			case "BeginBelow":
				return settle(Effect.as(parts.beginBelow(action.level), done))
			case "Commit":
				return settle(Effect.as(parts.commit, done))
			case "Rollback":
				return settle(Effect.as(parts.rollback, done))
		}
	}
})

/**
 * The rows of a raw result in field order. PgConnection keys each row by column name, so two columns with one name
 * cannot both be read: that is a defect in the schedule, which must alias them.
 */
const resultRows = (sql: string, result: RawQueryResult): Effect.Effect<TextRows> => {
	const names = Arr.map(result.fields, (field) => field.name)
	const repeated = Arr.filter(names, (name, index) => names.indexOf(name) !== index)
	if (repeated.length > 0) {
		return Effect.die(
			new Error(
				`a raw session cannot read result columns sharing a name (${Arr.join(repeated, ", ")}); alias them: ${sql}`
			)
		)
	}
	return Effect.succeed(
		Arr.map(result.rows, (row) => Arr.map(names, (name) => textOfValue(row[name])))
	)
}

/** A raw pinned session as a direct actor. Rows are read in the result's field order. */
const rawActor = (name: string, session: RawSession): DirectActor =>
	directActor<SqlError>({
		name,
		role: session.role,
		pid: session.pid,
		sql: (text) =>
			Effect.flatMap(session.query(text, []), (result) =>
				Effect.map(resultRows(text, result), (found) => ({
					rows: found,
					rowCount: result.rowCount
				}))
			),
		begin: session.begin,
		beginBelow: session.beginBelow,
		commit: session.commit,
		rollback: session.rollback
	})

/** A psql writer (substrate.psql) as a direct actor; its role is the writer's. */
const psqlActor = (name: string, writer: PsqlWriter): DirectActor =>
	directActor({
		name,
		role: writer.role,
		pid: writer.backend.pid,
		sql: (text) => writer.run(text),
		begin: writer.begin,
		beginBelow: writer.beginBelow,
		commit: writer.commit,
		rollback: writer.rollback
	})

/**
 * One direct actor to open: a raw session or a psql writer, logged in as `as`: a role's credentials (the owner), or a
 * world, whose login it logs in as and whose role it takes on before its first statement.
 */
export interface ActorSpec {
	readonly kind: "raw" | "psql"
	readonly as: Credentials | SubstrateWorld
}

/**
 * Opens one direct actor per spec in the current scope, raw sessions (substrate.session) and psql writers
 * (substrate.psql), each logged in as its spec's `as`.
 */
export const openActors = <const Specs extends Readonly<Record<string, ActorSpec>>>(
	substrate: SubstrateShape,
	specs: Specs
): Effect.Effect<
	{ readonly [K in keyof Specs & string]: DirectActor },
	SqlError | PsqlProcessError,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const opened = new Map<string, DirectActor>()
		for (const [name, spec] of Record.toEntries(specs)) {
			const actor = yield* openActor(substrate, name, spec)
			opened.set(name, actor)
		}
		return Record.map<keyof Specs & string, ActorSpec, DirectActor>(specs, (spec, name) =>
			defined(opened.get(name), `the ${spec.kind} actor ${name}, opened above`)
		)
	})

/** Opens one direct actor named `name` in the current scope, as its spec says. */
const openActor = (
	substrate: SubstrateShape,
	name: string,
	spec: ActorSpec
): Effect.Effect<DirectActor, SqlError | PsqlProcessError, Scope.Scope> =>
	spec.kind === "raw"
		? Effect.map(
				substrate.session({
					...("login" in spec.as ? worldSession(spec.as) : roleSession(spec.as)),
					label: name
				}),
				(session) => rawActor(name, session)
			)
		: Effect.map(
				substrate.psql({
					...("login" in spec.as ? worldPsql(spec.as) : rolePsql(spec.as)),
					label: name
				}),
				(writer) => psqlActor(name, writer)
			)

/**
 * The actor of a Db whose pool is `pool`, named by its own session: the pool leases the session it then holds idle for
 * the Db's later calls, one at a time (Db.open contacts nothing, so the lease opens it, or takes back the one an earlier
 * call of the Db left idle), and the actor is that session's backend, as the session answers pg_backend_pid()
 * (kernel/sanitize.ts ownPidQuery), under the login role it logged in as. A die when the lease or its answer fails.
 */
export const grizzleActor = (
	name: string,
	pool: Pick<SessionPool, "lease">
): Effect.Effect<GrizzleActor> =>
	Effect.orDie(
		Effect.scoped(
			Effect.flatMap(pool.lease, (session) =>
				Effect.flatMap(rowsOn(session, ownPidQuery, []), (rows) =>
					Option.match(ownPidOf(rows), {
						onNone: () =>
							Effect.die(
								new Error(`${name}'s session answered no backend pid: ${Formatter.format(rows)}`)
							),
						onSome: (pid): Effect.Effect<GrizzleActor> =>
							Effect.succeed({ name, role: session.role, pid })
					})
				)
			)
		)
	)
