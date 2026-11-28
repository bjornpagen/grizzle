/**
 * A statement of a migration's transaction the server refuses for want of shared memory (SQLSTATE 53200), which a
 * transaction that creates more objects than the server's lock table holds meets, is refused as the lock table
 * exhausted (LockTableExhausted): the refusal keeps the server's report and states the six settings that size the
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
 * Before any of that, the survey holds the server's table to the apply's largest transaction as its folders state it
 * (lockTablePreflight): a session answers the survey's read of the six settings with a table sized at the apply's
 * demand, max_locks_per_transaction drawn and max_connections the least that holds the largest stated transaction (a
 * file's meta.json count, or a first install's drift replay) with the session's one apply lock, or one slot of backends
 * short of it. The oracle is the folder's own stated counts against PostgreSQL 19's product: short, the apply is refused
 * as LockTableShort naming the largest count, the one apply lock and the settings, and no relation of the schema
 * exists; at the demand, it applies.
 *
 * Features: a table at the demand, and one slot short.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { applyOnSession, checkDrift, readLedger } from "#adapter/migrate/apply.ts"
import { LockTableShort } from "#adapter/migrate/errors.ts"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { migrationSession } from "#adapter/migrate/session.ts"
import { type BatchStatement, oneShotStatement } from "#adapter/wire/batch.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { proofStatements } from "#compiler/deploy/ledger/ledger.ts"
import { replayLocks } from "#compiler/deploy/locks/demand.ts"
import { readDecodedMeta, statedLocks } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	answeringLockTable,
	caseGen,
	caseSettings,
	ledgerLockGen,
	preflightGen,
	exhaustedOf,
	indexAmong,
	outOfLocks,
	type LockPlace,
	places,
	reasonAt,
	refusingAlongside,
	refusingTransaction
} from "#test/pg/migrate/lock-table.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import { kept, parsedTarget, reviewedSource } from "#test/support/pg/migrate/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { shopV1, shopV2 } from "#test/support/unit/deploy/schemas.ts"
import { tappedSession } from "#test/support/wire-tap.ts"

/** A migration that runs out of the server's lock table is refused by name at its place, with the server's report and lock-table settings, and commits nothing. */
export const lockTable = property.explore(aimed(caseGen, [["the ledger's lock", ledgerLockGen]]), {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: places satisfies ReadonlyArray<Reached<LockPlace>>,
	/** Its pre-conversion budget: runs 12, coverage cases 32 (lock-table.test.ts at bf4f43bb). */
	budget: { runs: 12, steered: 32 },
	check:
		({ caseSubstrate }, c: CaseOf<LockPlace>) =>
		(x) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const owner = substrate.owner.role
					const settings = yield* substrate.admin.queryValues(
						"SELECT current_setting('max_locks_per_transaction'), current_setting('max_connections'), current_setting('autovacuum_worker_slots'), current_setting('max_worker_processes'), current_setting('max_wal_senders'), current_setting('max_prepared_transactions')",
						[]
					)
					const [locks, connections, autovacuum, workers, senders, prepared] = trusted<
						readonly [string, string, string, string, string, string]
					>(defined(settings[0], "the server's settings"))
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const allocated = yield* substrate.schema({ create: false, label: "locks" })
							const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
							const ledgerStatements = succeeded(statementsFor(schema))
							const proofs = succeeded(proofStatements(schema))
							const tapped = yield* tappedSession({
								cluster: substrate.cluster,
								database: substrate.database,
								role: owner,
								password: substrate.owner.password
							})
							const m = migrationSession(tapped.session, {
								database: substrate.database,
								roles: { kind: "stems" }
							})
							const over = {
								schema: atName(allocated),
								logins: [],
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
							const target = (n: number): MigrationTarget =>
								parsedTarget({
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
							/** The place the refused statement is at, which `pick` notes. */
							let place: LockPlace = "the drift check's replay"
							/** The case's statement among a file transaction's, at the place its text names. */
							const pick = (statements: ReadonlyArray<BatchStatement>): number => {
								const index = indexAmong(x, statements.length)
								const sql = sentSql(defined(statements[index], "the refused statement"))
								place =
									sql === ledgerStatements.advise.text
										? "the file's advice"
										: sql === ledgerStatements.exclusive.text
											? "the ledger's lock"
											: sql === ledgerStatements.recordFolder.text ||
												  sql === ledgerStatements.recordFile.text ||
												  sql === ledgerStatements.recordHead.text
												? "a ledger row"
												: "a file's statement"
								return index
							}
							/**
							 * The case's statement among the drift check's replay, which its second flight sends first, before
							 * each scratch schema's description, one statement of one text: with no proof left, a whole one.
							 */
							const pickReplay = (statements: ReadonlyArray<BatchStatement>): number => {
								const describe = sentSql(
									defined(statements.at(-1), "a scratch schema's description")
								)
								const count = Arr.findFirstIndex(statements, (s) => sentSql(s) === describe)
								return indexAmong(
									x,
									defined(Option.getOrUndefined(count), "the first scratch schema's description")
								)
							}
							if (x.at === "the replay") {
								yield* m.transaction([oneShotStatement(proofs.clear.text, [])])
							}
							const failed =
								x.at === "the replay"
									? yield* Effect.flip(
											checkDrift(
												refusingAlongside(m, pickReplay),
												snapshot,
												ledgerStatements,
												proofs,
												[]
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
									settings: {
										maxLocksPerTransaction: Number(locks),
										maxConnections: Number(connections),
										autovacuumWorkerSlots: Number(autovacuum),
										maxWorkerProcesses: Number(workers),
										maxWalSenders: Number(senders),
										maxPreparedTransactions: Number(prepared)
									}
								},
								"the settings are the server's, read after the rollback"
							)
							const ledgerAfter = yield* Effect.result(readLedger(m, schema, ledgerStatements))
							assert.deepEqual(ledgerAfter, ledgerBefore, "the ledger is as it was")
							const relationsAfter = yield* relations()
							assert.deepEqual(relationsAfter, relationsBefore, "no relation was committed")
						})
					)
				}),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "the refusal its place names, the server's report and settings, and the ledger and relations as before"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/migrate/locks.ts",
			original:
				"\t\tmaxLocksPerTransaction: count(cells[0]),\n\t\tmaxConnections: count(cells[1]),",
			replacement:
				"\t\tmaxLocksPerTransaction: count(cells[1]),\n\t\tmaxConnections: count(cells[0]),",
			why: "The refusal reports max_connections as max_locks_per_transaction and the other way round."
		}
	]
})

/**
 * A migration whose largest transaction, as its folders state it, the server's lock table cannot hold beside the
 * session's apply lock is refused in the survey, before anything runs, naming the transaction, its locks, the apply
 * lock and the settings; one the table holds at exactly its demand applies.
 */
export const lockTablePreflight = property.explore(preflightGen, {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: ["the demand", "one below"] satisfies ReadonlyArray<
		Reached<"the demand" | "one below">
	>,
	budget: { runs: 6, steered: 8 },
	check:
		({ caseSubstrate }, c: CaseOf<"the demand" | "one below">) =>
		(x) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const allocated = yield* substrate.schema({ create: false, label: "preflight" })
						const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
						const tapped = yield* tappedSession({
							cluster: substrate.cluster,
							database: substrate.database,
							role: substrate.owner.role,
							password: substrate.owner.password
						})
						const m = migrationSession(tapped.session, {
							database: substrate.database,
							roles: { kind: "stems" }
						})
						const [drafted] = draftChain(
							[
								{
									desc: shopV1,
									options: {
										schema: atName(allocated),
										logins: [],
										extensions: [],
										codes: firstCodes
									},
									declared: noDeclarations
								}
							],
							fromEmpty
						)
						const g = defined(drafted, "the drafted folder")
						const source = reviewedSource(g, kept)
						const meta = succeeded(readDecodedMeta(g.folder.meta))
						const files = Arr.map(source.files, (f) =>
							defined(statedLocks(meta, f), `${f.name} states its locks`)
						)
						const largest = Arr.reduce(files, replayLocks(g.snapshot), (most, n) =>
							Math.max(most, n)
						)
						const total = largest + 1
						const settings = caseSettings(x, total)
						c.note(x.at)
						const outcome = yield* Effect.result(
							applyOnSession(answeringLockTable(m, settings), [
								parsedTarget({ snapshot: g.snapshot, folders: [source] })
							])
						)
						const relations = yield* substrate.admin.queryValues(
							"SELECT count(*)::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1",
							[schema]
						)
						if (x.at === "the demand") {
							assert.ok(outcome._tag === "Success", "a table that holds the demand applies")
							return
						}
						assert.ok(outcome._tag === "Failure", "a table one slot short refuses")
						const reason = outcome.failure.reason
						assert.ok(reason instanceof LockTableShort, outcome.failure.message)
						assert.equal(reason.locks, largest, "the largest stated transaction is named")
						assert.equal(reason.held, 1, "the session's one apply lock is counted")
						assert.deepEqual(reason.table, settings, "the settings are the survey's")
						assert.deepEqual(relations, [["0"]], "nothing ran")
					})
				),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "the folders' stated locks with the apply lock, against max_locks_per_transaction × (MaxBackends + max_prepared_transactions)"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/migrate/apply.ts",
			original: "largest.locks + held <= lockTableCapacity(lockTable)",
			replacement: "largest.locks <= lockTableCapacity(lockTable)",
			why: "The preflight leaves out the apply lock the session holds through every transaction."
		}
	]
})
