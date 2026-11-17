/** What the properties of lock-table.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Result } from "effect"
import { BatchRefused, ServerError } from "#adapter/errors/failures.ts"
import { LockTableExhausted, type MigrateError } from "#adapter/migrate/errors.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { type BatchStatement, oneShotStatement } from "#adapter/wire/batch.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { C } from "#compiler/plan/catalog.ts"
import { emitCatalog } from "#compiler/plan/common.ts"

export const places = [
	"the ledger's lock",
	"a file's statement",
	"a ledger row",
	"the drift check's replay"
] as const

export type LockPlace = (typeof places)[number]

/**
 * A case: the statement refused, the `k`-th from the start or from the end of the first file's transaction of the
 * shop's second or first version, or of the drift check's replay. A small `k` reaches both ends (the ledger's lock
 * first, the ledger's rows last), a large one every place between; the least case refuses the ledger's lock.
 */
interface Case {
	readonly at: "the file's start" | "the file's end" | "the replay"
	readonly versions: 1 | 2
	readonly k: number
}

export const caseGen: Gen<Case> = (source) => ({
	at: source.draw(element(["the file's start", "the file's end", "the replay"] as const)),
	versions: source.draw(element([2, 1] as const)),
	k: source.draw(
		weighted([
			[3, int(0, 2)],
			[1, int(0, 999)]
		])
	)
})

/**
 * A case refusing the first statement of a version's first file's transaction, the ledger's lock: the arm a case aimed
 * at "the ledger's lock" draws.
 */
export const ledgerLockGen: Gen<Case> = (source) => ({
	at: "the file's start",
	versions: source.draw(element([2, 1] as const)),
	k: 0
})

/** The index of a case's statement among `n`. */
export const indexAmong = (x: Case, n: number): number =>
	x.at === "the file's end" ? n - 1 - (x.k % n) : x.k % n

/** The server's report of a lock table exhausted, as PostgreSQL words it. */
export const outOfLocks = Object.freeze(
	new ServerError({
		sqlstate: sqlstates.outOfMemory,
		message: "out of shared memory",
		constraint: undefined,
		schema: undefined,
		table: undefined,
		column: undefined,
		dataType: undefined,
		detail: undefined,
		hint: 'You might need to increase "max_locks_per_transaction".'
	})
)

/** A statement the server refuses: a read of a relation no schema holds. */
const refused: BatchStatement = oneShotStatement(
	emitCatalog(
		C.query(
			[C.text("refused")],
			[C.fromObject({ schema: "pg_catalog", name: "grizzle_absent_relation" }, "z").item],
			undefined
		)
	),
	[]
)

/** `statements` with the one at `index` the refused one. */
const replaced = (
	statements: ReadonlyArray<BatchStatement>,
	index: number
): ReadonlyArray<BatchStatement> => Arr.map(statements, (s, i) => (i === index ? refused : s))

/**
 * `m`, whose first transaction is refused at the statement `pick` chooses among its statements, answered as the
 * server's 53200.
 */
export const refusingTransaction = (
	m: MigrationSession,
	pick: (statements: ReadonlyArray<BatchStatement>) => number
): MigrationSession => {
	let armed = true
	return {
		installation: m.installation,
		apart: m.apart,
		alongside: m.alongside,
		transaction: (statements) => {
			if (!armed) {
				return m.transaction(statements)
			}
			armed = false
			const index = pick(statements)
			return Effect.mapError(m.transaction(replaced(statements, index)), (failure) =>
				failure._tag === "BatchRefused" && failure.index === index
					? new BatchRefused({ index, failure: outOfLocks })
					: failure
			)
		}
	}
}

/** `m`, whose transaction alongside is refused at statement `index`, answered as the server's 53200. */
export const refusingAlongside = (m: MigrationSession, index: number): MigrationSession => ({
	installation: m.installation,
	apart: m.apart,
	transaction: m.transaction,
	alongside: (apart, statements, transaction) =>
		Effect.map(m.alongside(apart, replaced(statements, index), transaction), (answered) => ({
			alone: answered.alone,
			framed: Result.mapError(answered.framed, (failure) =>
				failure._tag === "BatchRefused" && failure.index === index
					? new BatchRefused({ index, failure: outOfLocks })
					: failure
			)
		}))
})

/** The lock table exhausted a MigrateError's reason carries at the place it stops, none for any other failure. */
export const exhaustedOf = (error: MigrateError): LockTableExhausted | undefined => {
	const reason = error.reason
	if (
		(reason._tag === "LedgerUnlocked" ||
			reason._tag === "StatementFailed" ||
			reason._tag === "RecordFailed") &&
		reason.failure instanceof LockTableExhausted
	) {
		return reason.failure
	}
	if (
		reason._tag === "DriftUnchecked" &&
		reason.failure._tag === "ReplayRefused" &&
		reason.failure.failure instanceof LockTableExhausted
	) {
		return reason.failure.failure
	}
	return undefined
}

/** The reason each place's refusal is. */
export const reasonAt: { readonly [P in LockPlace]: MigrateError["reason"]["_tag"] } = {
	"the ledger's lock": "LedgerUnlocked",
	"a file's statement": "StatementFailed",
	"a ledger row": "RecordFailed",
	"the drift check's replay": "DriftUnchecked"
}
