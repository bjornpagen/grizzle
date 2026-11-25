/** What the properties of grizzle-actor.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Fiber, Option } from "effect"
import type { SessionPool } from "#adapter/wire/pool.ts"
import { rowsOn } from "#test/pg/adapter/support.ts"
import { timekeepingHistory } from "#test/support/history/families.ts"
import type { PgConnection } from "#test/support/pg.ts"
import type { GrizzleActor } from "#test/support/schedules/actors.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"

/** A session of the writer's login beside it: held leased to the case's end, or let go just before the writer's naming. */
type Bystander = "held" | "departed"

/** A writer's first call: interrupted while it waits, whose connection its pool then drops, or none. */
type FirstCall = "interrupted" | "none"

/**
 * A writer of a case: the sessions of its login opened just before its actor is named, in order, and its first call
 * before the one whose backend is read.
 */
interface WriterSketch {
	readonly beside: ReadonlyArray<Bystander>
	readonly first: FirstCall
}

export type ActorFeature =
	| "a writer named alone"
	| "a writer named beside an earlier writer"
	| "a writer named beside a held session of its login"
	| "a writer named beside a departed session of its login"
	| "a writer whose interrupted call's connection its pool dropped"

const bystanders: Arr.NonEmptyReadonlyArray<Bystander> = ["held", "departed"]

const firstCalls: Arr.NonEmptyReadonlyArray<FirstCall> = ["interrupted", "none"]

const writerGen: Gen<WriterSketch> = (source) => ({
	beside: source.draw(array(element(bystanders), { min: 0, max: 2 })),
	first: source.draw(element(firstCalls))
})

export const caseGen: Gen<ReadonlyArray<WriterSketch>> = array(writerGen, { min: 1, max: 2 })

/** The advisory lock of a key text, which a first call waits for while the admin session holds it. */
const lockStatement = "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1::text))::text"

/** The backend `actor`'s call holds once it waits on a lock, polled from `admin` back to back. */
const waitingBackend = (admin: PgConnection, actor: GrizzleActor) =>
	Effect.gen(function* () {
		for (;;) {
			const backend = yield* actor.backend
			if (Option.isSome(backend) && (yield* lockWaitOf(admin, backend.value)) !== undefined) {
				return backend.value
			}
			yield* Effect.yieldNow
		}
	})

/**
 * A first call of the Db whose pool is `pool`, interrupted while its statement waits for the advisory lock of `key`,
 * which `admin` holds until the call has ended: the backend it waited on, which its pool drops with the cancelled
 * session.
 */
export const interruptedCall = (
	admin: PgConnection,
	pool: SessionPool,
	actor: GrizzleActor,
	key: string
) =>
	Effect.gen(function* () {
		yield* admin.queryValues(lockStatement, [key])
		const call = yield* Effect.forkChild(
			Effect.scoped(Effect.flatMap(pool.lease, (session) => rowsOn(session, lockStatement, [key]))),
			{ startImmediately: true }
		)
		const waited = yield* waitingBackend(admin, actor)
		yield* Effect.andThen(Fiber.interrupt(call), Fiber.await(call))
		yield* admin.queryValues(
			"SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1::text))::text",
			[key]
		)
		return waited
	})

/**
 * The timekeeping family's first schema installed once per member (history/families.ts timekeepingHistory's
 * templates), which each case's seat holds.
 */
export const timekeepingTemplate = defined(
	timekeepingHistory.templates(import.meta)["0"],
	"the timekeeping family's first template"
)
