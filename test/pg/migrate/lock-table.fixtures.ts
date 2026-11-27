/** What the properties of lock-table.test.ts read: its spaces, models and helpers. */

import { constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Result, String as Str } from "effect"
import { BatchRefused, ServerError } from "#adapter/errors/failures.ts"
import { LockTableExhausted, type MigrateError } from "#adapter/migrate/errors.ts"
import { type LockTableSettings, specialWorkerProcesses } from "#adapter/migrate/locks.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { type BatchStatement, oneShotStatement } from "#adapter/wire/batch.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { C } from "#compiler/plan/catalog.ts"
import { emitCatalog } from "#compiler/plan/common.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import { outputText } from "#test/support/wire.ts"

export const places = [
	"the file's advice",
	"the ledger's lock",
	"a file's statement",
	"a ledger row",
	"the drift check's replay"
] as const

export type LockPlace = (typeof places)[number]

/**
 * A case: the statement refused, the `k`-th from the start or from the end of the first file's transaction of the
 * shop's second or first version, or of the drift check's replay. A small `k` reaches both ends (the file's advice
 * first, then the ledger's lock, the ledger's rows last), a large one every place between; the least case refuses the
 * file's advice.
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

/**
 * `m`, whose transaction alongside, the drift check's, is refused in its second flight at the statement `pick` picks
 * among that flight's, answered as the server's 53200.
 */
export const refusingAlongside = (
	m: MigrationSession,
	pick: (statements: ReadonlyArray<BatchStatement>) => number
): MigrationSession => ({
	installation: m.installation,
	apart: m.apart,
	transaction: m.transaction,
	alongside: (apart, first, then, transaction) => {
		/** The refused statement's index in the second flight, once `then` made it. */
		let index = -1
		return Effect.map(
			m.alongside(
				apart,
				first,
				(alone, outcomes) =>
					Result.map(then(alone, outcomes), (second) => {
						index = pick(second.statements)
						return { ...second, statements: replaced(second.statements, index) }
					}),
				transaction
			),
			(answered) => ({
				alone: answered.alone,
				framed: Result.map(answered.framed, (opened) => ({
					...opened,
					made: Result.map(opened.made, (made) => ({
						...made,
						second: Result.mapError(made.second, (failure) =>
							failure._tag === "BatchRefused" && failure.index === index
								? new BatchRefused({ index, failure: outOfLocks })
								: failure
						)
					}))
				}))
			})
		)
	}
})

/** The lock table exhausted a MigrateError's reason carries at the place it stops, none for any other failure. */
export const exhaustedOf = (error: MigrateError): LockTableExhausted | undefined => {
	const reason = error.reason
	if (
		(reason._tag === "AdviceRefused" ||
			reason._tag === "LedgerUnlocked" ||
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
	"the file's advice": "AdviceRefused",
	"the ledger's lock": "LedgerUnlocked",
	"a file's statement": "StatementFailed",
	"a ledger row": "RecordFailed",
	"the drift check's replay": "DriftUnchecked"
}

/**
 * `m`, whose survey reads the server's lock-table settings as `table` (adapter/migrate/locks.ts lockTableColumns, the
 * last six cells of the survey's first row): every other answer as the server gave it.
 */
export const answeringLockTable = (
	m: MigrationSession,
	table: LockTableSettings
): MigrationSession => ({
	...m,
	apart: (statements) =>
		Effect.map(m.apart(statements), (answers) =>
			Arr.map(answers, (answer, i) => {
				const statement = statements[i]
				return statement !== undefined &&
					Str.includes("max_locks_per_transaction")(sentSql(statement))
					? Result.map(answer, (outcome) => ({
							...outcome,
							rows: Arr.map(outcome.rows, (row) => [
								...row.slice(0, -6),
								...Arr.map(
									[
										table.maxLocksPerTransaction,
										table.maxConnections,
										table.autovacuumWorkerSlots,
										table.maxWorkerProcesses,
										table.maxWalSenders,
										table.maxPreparedTransactions
									],
									(n) => outputText(String(n))
								)
							])
						}))
					: answer
			})
		)
})

/**
 * A preflight's case: the server's max_locks_per_transaction `slots`, and its lock table sized at the apply's demand
 * (every other setting 0 but max_connections, the least that holds it at `slots`) or one slot of backends short of it.
 */
export interface PreflightCase {
	readonly slots: number
	readonly at: "the demand" | "one below"
}

export const preflightGen: Gen<PreflightCase> = (source) => ({
	slots: source.draw(
		weighted([
			[1, constant(1)],
			[2, int(2, 64)]
		])
	),
	at: source.draw(element(["the demand", "one below"] as const))
})

/**
 * The settings a case sizes: max_locks_per_transaction its slots, at most a quarter of `total`, and max_connections the
 * least whose table holds `total` at them, or one fewer. A quarter keeps that least at 2 or more beside the special
 * workers, so one fewer is still a server's max_connections, at least 1: more slots would size the demand's table at
 * max_connections 0 or below, which no server holds and the survey reads as no setting.
 */
export const caseSettings = (x: PreflightCase, total: number): LockTableSettings => {
	const slots = Math.min(x.slots, Math.floor(total / 4))
	return {
		maxLocksPerTransaction: slots,
		maxConnections:
			Math.ceil(total / slots) - specialWorkerProcesses - (x.at === "one below" ? 1 : 0),
		autovacuumWorkerSlots: 0,
		maxWorkerProcesses: 0,
		maxWalSenders: 0,
		maxPreparedTransactions: 0
	}
}
