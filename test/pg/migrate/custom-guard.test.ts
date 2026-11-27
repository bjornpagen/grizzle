/**
 * A custom migration's data step writes an immutable relation's rows, on PostgreSQL 19 (adapter/migrate/apply.ts
 * guardBracket, physical/ddl/immutable.ts dataStepBracket): the README's promise that a migration's data steps on a
 * guarded table run with its guard dropped and create it again in the same transaction, held for a data step written by
 * hand, which grizzle drafts no bracket into.
 *
 * Each case installs Sets, an immutable relation holding a set over a roster of two handles, one row holding both, and
 * migrates a custom migration (`grizzle generate --custom`) whose data step rewrites the row's set to the empty one:
 *
 * - **commits:** the step applies, the row holds the empty set, and the guard stands again, so the owner's own
 *   UPDATE of the row outside any migration is refused, 42501;
 * - **fails:** the step's later statement fails (22012), the migration stops at it, the row holds its set as before,
 *   and the guard stands, the owner's UPDATE refused 42501: the step's dropping rolled back with it;
 * - **alone:** a no-transaction file has no transaction to bracket, so the guard refuses its UPDATE and the migration
 *   says why: a no-transaction custom step cannot write a guarded table; use a transactional step;
 * - **at a draft's slot:** a draft whose Structure fills another immutable relation's new field by its placeholder holds
 *   a data-step slot, where the reviewer's step rewrites Sets' set: the draft brackets every table the installation
 *   guards and the next version keeps, so the folder applies and Sets' guard stands again after it;
 * - **before a roster shrink:** a custom step clears a handle's bit from Sets, and the migration removing the handle,
 *   applied with it, finds no set holding it: the README's "change or delete those rows in a data step first".
 *
 * Oracle: the README's statement of the guard and of data steps, read row by row. Features: each way a step runs.
 */
import { assert } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, String as Str } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { dataSteps } from "#test/pg/migrate/custom-guard.dictionary.ts"
import {
	type DataStep,
	draftedSlot,
	guardedInstall,
	shrinkAfterDataStep
} from "#test/pg/migrate/custom-guard.fixtures.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A custom data step writes a guarded table inside its transaction's bracket, its guard enabled again after it or after its failure, and a no-transaction one is refused saying why. */
export const aCustomDataStepWritesAGuardedTableInsideItsTransactionsBracketItsGuardEnabledAgainAfterItOrItsFailureAndANoTransactionOneIsRefusedSayingWhy =
	property.exhaust(finite(word(dataSteps)), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: dataSteps satisfies ReadonlyArray<Reached<DataStep>>,
		check:
			({ substrate }, c: Case<DataStep>) =>
			(step) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							c.note(step)
							if (step === "at a draft's slot") {
								const d = yield* draftedSlot
								const drafted = yield* Effect.result(d.migrate)
								assert.ok(
									drafted._tag === "Success",
									"the draft with the data step at its slot applies"
								)
								const emptied = yield* d.held
								assert.deepEqual(emptied, ["00000000"], "the row holds the empty set")
								yield* Effect.orDie(expectSqlstate(d.ownerUpdate, sqlstates.insufficientPrivilege))
								return
							}
							if (step === "before a roster shrink") {
								const d = yield* shrinkAfterDataStep
								const shrunk = yield* Effect.result(d.migrate)
								assert.ok(shrunk._tag === "Success", "the data step and the removal after it apply")
								const right = yield* d.held
								assert.deepEqual(right, ["01000000"], "the row holds Right alone")
								yield* Effect.orDie(expectSqlstate(d.ownerUpdate, sqlstates.insufficientPrivilege))
								return
							}
							const s = yield* guardedInstall(step)
							const outcome = yield* Effect.result(s.migrate)
							switch (step) {
								case "commits": {
									assert.ok(outcome._tag === "Success", "the data step applies")
									const emptied = yield* s.held
									assert.deepEqual(emptied, ["00000000"], "the row holds the empty set")
									break
								}
								case "fails": {
									assert.ok(outcome._tag === "Failure", "the failing data step stops the migration")
									const reason = outcome.failure.reason
									assert.ok(
										reason._tag === "StatementFailed" && reason.statement === 2,
										"at the step's statement that failed"
									)
									const kept = yield* s.held
									assert.deepEqual(kept, ["11000000"], "the row holds its set as before")
									break
								}
								case "alone": {
									assert.ok(outcome._tag === "Failure", "the guard refuses a statement run alone")
									const error = outcome.failure
									assert.ok(
										error.reason._tag === "GuardedTableUnbracketed" &&
											error.reason.table === `${s.table.schema}.${s.table.name}`,
										`the migration names the guarded table: ${error.message}`
									)
									assert.ok(
										Str.includes(
											"a no-transaction custom step cannot write a guarded table; use a transactional step"
										)(error.message),
										"and says why"
									)
									const unwritten = yield* s.held
									assert.deepEqual(unwritten, ["11000000"], "the row holds its set as before")
									break
								}
							}
							yield* Effect.orDie(expectSqlstate(s.ownerUpdate, sqlstates.insufficientPrivilege))
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "README: an immutable table's guard, and a migration's data steps run with it dropped and created again in their transaction"
		},
		box: "each way a custom data step runs",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original:
					'\t\t\tfolder.meta.kind === "custom"\n\t\t\t\t? guardBracket(session, levels, at, schema)\n',
				replacement: "\t\t\tfalse\n\t\t\t\t? guardBracket(session, levels, at, schema)\n",
				why: "A custom data step runs with no bracket: the guard refuses the committing step's UPDATE, 42501, and the migration stops."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					'\t\t\t\treturn v.kind === "immutableTrigger" && kept.has(nameKey(v.create.table))\n',
				replacement: '\t\t\t\treturn v.kind === "immutableTrigger" && kept.has("")\n',
				why: "A draft brackets no guarded table at its data-step slot: the reviewer's UPDATE of Sets there is refused, 42501."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original: "\t\t\t\treturn table !== undefined && guarded.has(table)\n",
				replacement: "\t\t\t\treturn false\n",
				why: "A no-transaction step's guard refusal is a bare StatementFailed that never says why."
			}
		]
	})
