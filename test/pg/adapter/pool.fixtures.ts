/** What the properties of pool.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Scope } from "effect"
import { type BatchStatement, oneShotStatement, runTransaction } from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import { runAlone } from "#test/support/pg.ts"
import { pickGen } from "#test/support/pick.ts"
import { testSql } from "#test/support/sql.ts"
import { paramText } from "#test/support/wire.ts"

/** One step as drawn: what it does, and which leased session it picks. */
interface StepSketch {
	readonly kind: "lease" | "release" | "retire" | "lose"
	readonly pick: number
}

interface Sequence {
	readonly max: number
	readonly steps: ReadonlyArray<StepSketch>
}

export const sequenceGen: Gen<Sequence> = (source) => ({
	max: source.draw(int(1, 3)),
	steps: source.draw(
		array<StepSketch>(
			(step) => ({
				kind: step.draw(element(["lease", "release", "retire", "lose"] as const)),
				pick: step.draw(pickGen)
			}),
			{ min: 1, max: 16 }
		)
	)
})

export type PoolFeature =
	| "retired"
	| "connection lost"
	| "released"
	| "leased after a retirement"
	| "leased an idle session"
	| "leased a new session"

export const situations: Arr.NonEmptyReadonlyArray<PoolFeature> = [
	"retired",
	"connection lost",
	"released",
	"leased after a retirement",
	"leased an idle session",
	"leased a new session"
]

/** A leased session in the model: the session, its backend and the scope its lease lives in. */
export interface Held {
	readonly session: Session
	readonly pid: number
	readonly scope: Scope.Closeable
}

/** What an interrupted statement waits on: the server's clock, or an advisory lock another session holds. */
type LongStatement = "sleep" | "lock"

/** How the statement runs: alone, its own implicit transaction, or inside a transaction that ends with COMMIT. */
type FlightForm = "alone" | "transaction"

interface Interrupted {
	readonly max: number
	readonly statement: LongStatement
	readonly form: FlightForm
}

export const interruptedCases: Gen<Interrupted> = (source) => ({
	max: source.draw(int(1, 3)),
	statement: source.draw(element<LongStatement>(["sleep", "lock"])),
	form: source.draw(element<FlightForm>(["alone", "transaction"]))
})

export type InterruptedFeature = `${LongStatement} ${FlightForm}`

/**
 * The advisory lock key the lock cases hold, in a session of their own that the case's scope ends, which no other
 * test takes.
 */
export const lockKey = "7366231908012114001"

/** The long statement of a case, which runs until a CancelRequest stops it. */
export const longStatement = (statement: LongStatement): BatchStatement =>
	statement === "sleep"
		? oneShotStatement(testSql("SELECT pg_catalog.pg_sleep(600)::text"), [])
		: oneShotStatement(testSql("SELECT pg_catalog.pg_advisory_lock($1::int8)::text"), [
				paramText(lockKey)
			])

/** Runs `statement` on `session` in the form drawn: alone, or in a read-only transaction that ends with COMMIT. */
export const runIn = (session: Session, form: FlightForm, statement: BatchStatement) =>
	form === "alone"
		? Effect.asVoid(runAlone(session, statement))
		: Effect.asVoid(
				runTransaction(session, [statement], {
					access: "readOnly",
					deferrable: false,
					end: "COMMIT"
				})
			)

/**
 * Where the tap's session stands when its layer is released: idle in the pool, leased, or running a statement of `rows`
 * rows whose answer the gate cuts after `through` backend messages.
 */
type Standing =
	| { readonly kind: "idle" }
	| { readonly kind: "leased" }
	| { readonly kind: "running"; readonly rows: number; readonly through: number }

/** Every standing, a statement's answer cut at each of its first messages: a few rows, and a cut short of their end. */
export const standings: Gen<Standing> = (source) => {
	const kind = source.draw(element<Standing["kind"]>(["idle", "leased", "running"]))
	if (kind !== "running") {
		return { kind }
	}
	const rows = source.draw(int(0, 3))
	return { kind, rows, through: source.draw(int(0, rows + 4)) }
}

export type StalledFeature =
	| "released idle"
	| "released leased"
	| "released before any answer"
	| "released mid-answer"

/** The running statement: `rows` rows, one round trip of the extended protocol. */
export const seriesSql = "SELECT pg_catalog.generate_series(1, $1::int4)::text"
