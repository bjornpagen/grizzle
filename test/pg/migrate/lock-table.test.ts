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
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { applyOnSession, checkDrift } from "#adapter/migrate/apply.ts"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { migrationSession } from "#adapter/migrate/session.ts"
import { type BatchStatement, oneShotStatement } from "#adapter/wire/batch.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { proofStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	caseGen,
	ledgerLockGen,
	exhaustedOf,
	indexAmong,
	outOfLocks,
	type LockPlace,
	places,
	reasonAt,
	refusingAlongside,
	refusingTransaction
} from "#test/pg/migrate/lock-table.fixtures.ts"
import { kept, parsedTarget, reviewedSource } from "#test/pg/migrate/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations, ownedBy } from "#test/support/migrate/kit.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"
import { shopV1, shopV2 } from "#test/unit/deploy/schemas.ts"

/** A migration that runs out of the server's lock table is refused by name at its place, with the server's report and lock-table settings, and commits nothing. */
export const lockTable = property.explore(aimed(caseGen, [["the ledger's lock", ledgerLockGen]]), {
	needs: { caseSubstrate: Substrate.installing },
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
						"SELECT current_setting('max_locks_per_transaction'), current_setting('max_connections'), current_setting('max_prepared_transactions')",
						[]
					)
					const [locks, connections, prepared] = trusted<readonly [string, string, string]>(
						defined(settings[0], "the server's settings")
					)
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
									sql === ledgerStatements.exclusive.text
										? "the ledger's lock"
										: sql === ledgerStatements.recordFolder.text ||
											  sql === ledgerStatements.recordFile.text
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
				}),
				Substrate,
				caseSubstrate
			),
	oracle: {
		kind: "specification",
		name: "the refusal its place names, the server's report and settings, and the ledger and relations as before"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/migrate/apply.ts",
			original: "\t\t\t\t\tmaxLocksPerTransaction: locks,\n\t\t\t\t\tmaxConnections: connections,",
			replacement:
				"\t\t\t\t\tmaxLocksPerTransaction: connections,\n\t\t\t\t\tmaxConnections: locks,",
			why: "The refusal reports max_connections as max_locks_per_transaction and the other way round."
		}
	]
})
