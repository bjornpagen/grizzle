/**
 * A statement of a migration's transaction the server refuses for want of shared memory (SQLSTATE 53200), which a
 * transaction that creates more objects than the server's lock table holds meets, is refused as the lock table
 * exhausted (LockTableExhausted): the refusal keeps the server's report and states the three settings that size the
 * table, max_locks_per_transaction among them, read in the migration's session once the transaction rolled back.
 *
 * The shared cluster's lock table is no thing a test may fill (it serves every session at once), so a session stands
 * in for the server's answer at one place: it sends the transaction with the statement there replaced by one the
 * server refuses (a read of a relation no schema holds), so every statement before it ran and rolled back, and answers
 * that refusal with the server's own 53200 report. The statement is drawn, the k-th from either end of the first file's
 * transaction of a shop's first or second version (the ledger's lock, a statement of the file, or a ledger row) or of
 * the drift check's replay. The
 * oracle is the migration's own record, restated: the refusal is the one its place names (LedgerUnlocked,
 * StatementFailed with its number, RecordFailed, or the replay's ReplayRefused under DriftUnchecked), its failure
 * LockTableExhausted with the server's report and the settings the server holds, and nothing is left committed: the
 * ledger and the schema's relations are as they were before the refused transaction. The refusal is asserted by its
 * tag and fields, never its words.
 *
 * Features: each place, the ledger's lock, a file's statement, a ledger row and the drift check's replay.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): lock-table-settings-swapped (the refusal reports
 * max_connections as max_locks_per_transaction and the other way round).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { driftFlight } from "#adapter/admission/drift.ts"
import { BatchRefused, ServerError } from "#adapter/errors/failures.ts"
import { applyOnSession, checkDrift } from "#adapter/migrate/apply.ts"
import { LockTableExhausted, type MigrateError } from "#adapter/migrate/errors.ts"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { type MigrationSession, migrationSession } from "#adapter/migrate/session.ts"
import { type BatchStatement, oneShotStatement } from "#adapter/wire/batch.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { C } from "#compiler/plan/catalog.ts"
import { emitCatalog } from "#compiler/plan/common.ts"
import { kept, reviewedSource } from "#test/pg/migrate/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { draftChain, fromEmpty, noDeclarations, ownedBy } from "#test/support/migrate/kit.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"
import { shopV1, shopV2 } from "#test/unit/deploy/schemas.ts"

const places = [
	"the ledger's lock",
	"a file's statement",
	"a ledger row",
	"the drift check's replay"
] as const
type Place = (typeof places)[number]

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

const caseGen: Gen<Case> = (source) => ({
	at: source.draw(element(["the file's start", "the file's end", "the replay"] as const)),
	versions: source.draw(element([2, 1] as const)),
	k: source.draw(
		weighted([
			[3, int(0, 2)],
			[1, int(0, 999)]
		])
	)
})

/** The index of a case's statement among `n`. */
const indexAmong = (x: Case, n: number): number =>
	x.at === "the file's end" ? n - 1 - (x.k % n) : x.k % n

/** The server's report of a lock table exhausted, as PostgreSQL words it. */
const outOfLocks = new ServerError({
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
const refusingTransaction = (
	m: MigrationSession,
	pick: (statements: ReadonlyArray<BatchStatement>) => number
): MigrationSession => {
	let armed = true
	return {
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
const refusingAlongside = (m: MigrationSession, index: number): MigrationSession => ({
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
const exhaustedOf = (error: MigrateError): LockTableExhausted | undefined => {
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
const reasonAt: { readonly [P in Place]: MigrateError["reason"]["_tag"] } = {
	"the ledger's lock": "LedgerUnlocked",
	"a file's statement": "StatementFailed",
	"a ledger row": "RecordFailed",
	"the drift check's replay": "DriftUnchecked"
}

layer(Substrate.layer)("a migration that runs out of the server's lock table", (it) => {
	it.effect(
		"is refused by name at its place, with the server's report and lock-table settings, and commits nothing",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const owner = substrate.owner.role
					const settings = yield* substrate.admin.queryValues(
						"SELECT current_setting('max_locks_per_transaction'), current_setting('max_connections'), current_setting('max_prepared_transactions')",
						[]
					)
					const [locks, connections, prepared] = trusted<readonly [string, string, string]>(
						defined(settings[0], "the server's settings")
					)
					return yield* explore(
						{
							suite: "migrate/lock-table",
							draw: drawn(caseGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the refusal its place names, the server's report and settings, and the ledger and relations as before"
							},
							coverage: required<Place>(places, { cases: 32, sense: notesOnly }),
							kept: [],
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(x, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const allocated = yield* substrate.schema({ create: false, label: "locks" })
									const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
									const ledgerStatements = succeeded(statementsFor(schema))
									const tapped = yield* tappedSession({
										cluster: substrate.cluster,
										database: substrate.database,
										role: owner,
										password: substrate.owner.password
									})
									const m = migrationSession(tapped.session)
									const over = {
										schema: atName(allocated),
										owner: ownedBy(owner),
										extensions: [],
										codes: firstCodes
									}
									const folders: ReadonlyArray<GenerateResult> = draftChain(
										Arr.map([shopV1, shopV2].slice(0, x.versions), (desc) => ({
											desc,
											options: over,
											declared: noDeclarations
										})),
										fromEmpty
									)
									const sources = Arr.map(folders, (g) => reviewedSource(g, kept))
									const target = (n: number): MigrationTarget => ({
										snapshot: defined(folders[n - 1], "a drafted folder").snapshot,
										folders: sources.slice(0, n)
									})
									if (x.versions === 2 || x.at === "the replay") {
										yield* applyOnSession(m, [target(1)])
									}
									const relations = () =>
										substrate.admin.queryValues(
											"SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1",
											[schema]
										)
									const ledgerBefore = yield* Effect.result(readLedger(m, schema, ledgerStatements))
									const relationsBefore = yield* relations()
									const snapshot = target(1).snapshot
									const replay = succeeded(driftFlight(snapshot)).replay
									/** The place the refused statement is at, which `pick` notes. */
									let place: Place = "the drift check's replay"
									/** The case's statement among a file transaction's, at the place its text names. */
									const pick = (statements: ReadonlyArray<BatchStatement>): number => {
										const index = indexAmong(x, statements.length)
										const sql = sentSql(defined(statements[index], "the refused statement"))
										place =
											sql === ledgerStatements.exclusive.text
												? "the ledger's lock"
												: sql === ledgerStatements.recordFolder.text ||
													  sql === ledgerStatements.recordFile.text
													? "a ledger row"
													: "a file's statement"
										return index
									}
									const failed =
										x.at === "the replay"
											? yield* Effect.flip(
													checkDrift(
														refusingAlongside(m, replay.from + indexAmong(x, replay.count)),
														snapshot,
														ledgerStatements
													)
												)
											: yield* Effect.flip(
													applyOnSession(refusingTransaction(m, pick), [target(x.versions)])
												)
									const exhausted = defined(
										exhaustedOf(failed),
										`the refusal carries the lock table exhausted: ${failed.message}`
									)
									c.note(place)
									assert.equal(failed.reason._tag, reasonAt[place], failed.message)
									assert.equal(exhausted.error, outOfLocks, "the server's report is kept")
									assert.deepEqual(
										exhausted.table,
										{
											kind: "read",
											maxLocksPerTransaction: locks,
											maxConnections: connections,
											maxPreparedTransactions: prepared
										},
										"the settings are the server's, read after the rollback"
									)
									const ledgerAfter = yield* Effect.result(readLedger(m, schema, ledgerStatements))
									assert.deepEqual(ledgerAfter, ledgerBefore, "the ledger is as it was")
									const relationsAfter = yield* relations()
									assert.deepEqual(relationsAfter, relationsBefore, "no relation was committed")
								})
							)
					)
				})
			)
	)
})
