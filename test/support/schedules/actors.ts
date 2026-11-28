import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Formatter, Option, Predicate, Record, type Scope } from "effect"
import type { SessionPool } from "#adapter/wire/pool.ts"
import type { SqlError } from "#test/support/pg.ts"
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
	claimsOfNoFact,
	rolePsql,
	roleSession,
	type SubstrateShape,
	type TextRows,
	worldPsql,
	worldSession
} from "#test/support/substrate/substrate.ts"
import { heldBackend } from "#test/support/worlds/execute/pool.ts"

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
 * A grizzle writer: its steps are operations the runner (or the explorer) runs itself; the lock barrier watches
 * `backend`.
 */
export interface GrizzleActor {
	readonly name: string
	readonly role: string
	/**
	 * The backend its Db's call holds now, none between its calls (worlds/execute/pool.ts heldBackend): read at every
	 * look, never remembered, since the pool holds no one connection for good: it drops one whose call was interrupted
	 * mid-statement and opens another for the next call.
	 */
	readonly backend: Effect.Effect<Option.Option<number>>
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

/** A raw pinned session as a direct actor. Rows are read by position, in the result's field order (RawAnswer). */
const rawActor = (name: string, session: RawSession): DirectActor =>
	directActor<SqlError>({
		name,
		role: session.role,
		pid: session.pid,
		sql: (text) =>
			Effect.map(session.answer(text, []), (answer) => ({
				rows: Arr.map(answer.rows, (row) => Arr.map(row, textOfValue)),
				rowCount: answer.rowCount
			})),
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
					...("login" in spec.as ? worldSession(spec.as, claimsOfNoFact) : roleSession(spec.as)),
					label: name
				}),
				(session) => rawActor(name, session)
			)
		: Effect.map(
				substrate.psql({
					...("login" in spec.as ? worldPsql(spec.as, claimsOfNoFact) : rolePsql(spec.as)),
					label: name
				}),
				(writer) => psqlActor(name, writer)
			)

/**
 * The actor of a Db whose pool is `pool`, the Db's own (a DbLayer of its own, so every lease of the pool is one of the
 * Db's calls): its login role and the backend its call holds, for as long as the scope lasts.
 */
export const grizzleActor = (
	name: string,
	pool: Pick<SessionPool, "role" | "native">
): Effect.Effect<GrizzleActor, never, Scope.Scope> =>
	Effect.map(heldBackend(pool), (backend) => ({ name, role: pool.role, backend }))
