/**
 * A migration file's transaction runs under the plan advice its meta.json records of its data steps, on PostgreSQL 19:
 * the apply runner sets it first (LedgerStatements `advise`, adapter/migrate/apply.ts runFile), so every statement of
 * the file's transaction is planned under it, its data steps and the runner's own rows of the ledger alike.
 *
 * Property, over the box of runner-advice.fixtures.ts's schema, whose first migration fills its stored Ones by a data
 * step reading T at a constant through T's index on `a`: applied by the runner, each file whose record holds advice
 * runs in a transaction that opens with exactly that advice; the plan laws (test/support/advice.ts, Laws 1-3) hold over
 * its data steps planned under the advice the runner set; and Law 3's rule that each atom is matched in one statement
 * of its scope holds over the rest of the transaction: no row of the ledger the runner sends in it, cost-chosen and
 * named by its table's own name, meets an atom of the file's advice, planned under it.
 *
 * Oracle: PostgreSQL's own plans under the advice in force, read by the laws' harness, and the transaction the runner
 * sent, read off its session.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import type { BatchStatement } from "#adapter/wire/batch.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { ledgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import {
	adviceBefore,
	keeping,
	type Migration,
	matchedIn,
	migrationOf,
	reviewerStatement,
	statementScope,
	writingAtStructure,
	openingAdvice,
	rowsScope,
	runnerSchema
} from "#test/pg/migrate/runner-advice.fixtures.ts"
import { fileScope, type LawScope, lawsOver, plannedScope } from "#test/support/advice.ts"
import { succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { compile, draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import {
	apply,
	kept,
	noFurther,
	openMigrator,
	reviewedSource
} from "#test/support/pg/migrate/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A migration file's transaction runs under the plan advice its meta.json records, and the plan laws hold over it. */
export const aMigrationFilesTransactionRunsUnderTheAdviceItsRecordHolds = property.exhaust(
	finite(int(0, 2)),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"the first migration",
			"a later migration",
			"a reviewer's statement among the recorded ones"
		] satisfies ReadonlyArray<Reached<Migration>>,
		check:
			({ substrate }, c: Case<Migration>) =>
			(drawn) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const allocated = yield* s.schema({ create: false, label: "runner_advice" })
						const options = {
							schema: atName(allocated),
							logins: [],
							extensions: [],
							codes: firstCodes
						}
						const migration = migrationOf(drawn)
						const versions = migration === "a later migration" ? [false, true] : [true]
						const chain = draftChain(
							Arr.map(versions, (withOnes) => ({
								desc: runnerSchema(withOnes),
								options,
								declared: noDeclarations
							})),
							fromEmpty
						)
						const g = defined(chain.at(-1), "the migration that adds Ones")
						const schemaIdent = identifierOf(identity.schema(parsedSchemaName(allocated)))
						const ledger = succeeded(ledgerStatements(schemaIdent))
						const reviewer = reviewerStatement(schemaIdent)
						const writes =
							migration === "a reviewer's statement among the recorded ones"
								? { ...kept, edit: writingAtStructure(reviewer) }
								: kept
						const sent: Array<ReadonlyArray<BatchStatement>> = []
						const migrator = yield* openMigrator(s, s.owner)
						yield* apply(
							keeping(migrator, sent),
							{ snapshot: g.snapshot, folders: Arr.map(chain, (d) => reviewedSource(d, writes)) },
							noFurther
						)
						const opened = Arr.flatMap(sent, (t) => {
							const advice = openingAdvice(t, ledger)
							return advice === undefined ? [] : [advice]
						})
						const advised = Arr.filter(g.files, (f) => f.advice !== "")
						assert.ok(
							Arr.isReadonlyArrayNonEmpty(advised),
							`${migration} drafts a file of data steps, its record holding advice`
						)
						const resolve = compile(runnerSchema(true), options).resolve
						/** A scope planned in a transaction of its own under its vehicle's advice, rolled back. */
						const planned = (scope: LawScope) =>
							Effect.scoped(
								Effect.flatMap(s.admin.pin, (pinned) => {
									const session: BenchSession = { values: pinned.queryValues }
									return Effect.acquireUseRelease(
										pinned.query("BEGIN", []),
										() => plannedScope(session, scope),
										() => Effect.orDie(pinned.query("ROLLBACK", []))
									)
								})
							)
						for (const file of advised) {
							assert.ok(
								Arr.contains(opened, file.advice),
								`the runner opens the transaction of ${file.file.name} with the advice its record holds, ${file.advice}; it opened ${Arr.join(opened, " | ")}`
							)
							const steps = fileScope(file, resolve, file.advice)
							assert.equal(
								steps.advice,
								file.advice,
								`the advice of ${file.file.name} is what its data steps' plans carry`
							)
							const stepsPlanned = yield* planned(steps)
							assert.deepEqual(
								lawsOver(steps, stepsPlanned),
								[],
								`the plan laws hold over ${steps.label}, carrying ${steps.advice}\n${Arr.join(
									Arr.map(steps.statements, (st) => `${st.label}: ${st.sql}`),
									"\n"
								)}`
							)
							const rowsPlanned = yield* planned(rowsScope(ledger, file.advice))
							assert.deepEqual(
								matchedIn(rowsPlanned.plans),
								[],
								`no row of the ledger the runner sends in the transaction of ${file.file.name} meets an atom of its advice, ${file.advice}`
							)
						}
						if (migration === "a reviewer's statement among the recorded ones") {
							const transaction = defined(
								Arr.findFirst(sent, (t) => Arr.some(t, (st) => sentSql(st) === reviewer)).pipe(
									Option.getOrUndefined
								),
								"the transaction the reviewer's statement runs in"
							)
							const inForce = defined(
								adviceBefore(transaction, ledger, reviewer),
								"the advice in force at the reviewer's statement"
							)
							const reviewed = yield* planned(
								statementScope("the reviewer's statement", reviewer, inForce)
							)
							assert.deepEqual(
								matchedIn(reviewed.plans),
								[],
								`the reviewer's statement, which names T r1, meets no atom of the advice in force where the runner sends it, ${inForce}`
							)
						}
						c.note(migration)
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's plans of the file's transaction under the advice the runner set, read by the plan laws"
		},
		box: "runner-advice.fixtures.ts's schema, its first migration, a later one adding Ones over T, each filling Ones by reading T at a constant, and the first with a reviewer's statement aliased r1 at the end of its Structure file",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/ledger/ledger.ts",
				original: "\tconst ledger = ledgerTableName\n",
				replacement: '\tconst ledger = "r1"\n',
				why: "A cost-chosen row of the ledger is named r1 again, the first alias a file's advice scope mints: the redraft's UPDATE of the ledger, sent in the file's transaction, meets the atom the file's data steps carry for r1, matched in two statements of the transaction (Law 3)."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original: "\t\t\t{ stage: adviceStage, statement: advise(file.advice.advice) },\n",
				replacement: "",
				why: "A file's transaction no longer opens with its advice: its data steps are planned by PostgreSQL's costs alone, under no advice of the plans its record holds."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original: '\t\tconst wanted = stated.reviewed[index] === true ? "" : stated.advice\n',
				replacement: "\t\tconst wanted = stated.advice\n",
				why: "A reviewer's statement runs under the file's advice: the reviewer's read of T named r1 meets the atoms the file's data steps carry for r1 (Law 3)."
			}
		]
	}
)
