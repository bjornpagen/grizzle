/**
 * A direct SQL writer meets PostgreSQL's native errors for the two kinds of object the generated direct-writer
 * populations do not draw. The direct-writer model (model.ts) owns keys, candidate keys, foreign keys at the statement
 * and at COMMIT, projected keys' UNIQUEs, identity columns, immutability, refined text, typmod numerics,
 * closed handles and missing fields over generated write schemas; the generated histories (test/support/history) own
 * span keys' exclusion and every deferred foreign key at COMMIT, over the law families; isolation.test.ts owns the
 * guard's refusal of a write below SERIALIZABLE.
 *
 * psql children log in over verify-full TLS as the login of test/pg/direct-writers/schema.ts and take on one of its
 * roles, holding exactly the role's derived grants:
 *
 * - a declared row check and a contract's CHECK raise 23514 at the statement, each under a constraint whose law the
 *   installation's constraint-to-law map names (the row check's the law its statement declares, the contract's the
 *   contract's own), and nothing reaches the tables: a property over drawn direct transactions of one to three INSERTs
 *   into Pair (a, b over 0..2, so a = b, the row check's refusal, is frequent) and Entry (an amount of -2 to 5 over a
 *   stored account, so a negative one, the contract's refusal, is too, and ids that may repeat a stored or an earlier
 *   one), against a model that names the first refusal in the order PostgreSQL meets them (a domain's CHECK as the
 *   value is coerced, then the row's CHECK, then the key's unique index, 23505), or commits its state;
 * - a write to a derived relation is refused by privilege, 42501: a property over drawn INSERTs, UPDATEs and DELETEs
 *   of it (rows, a column and a filter drawn) sent by each role of the login, the one that reads it and the one that
 *   holds none of it, against PostgreSQL's own privilege check: no role holds the write's privilege on the derived
 *   relation (has_table_privilege), which no generator writes directly.
 *
 * The contract's CHECK is the one the installation names for it.
 */
import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, array, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { quoteString } from "#compiler/core/text.ts"
import {
	type DerivedWrite,
	derivedWriteGen,
	deskRoles,
	deskTemplate,
	type Insert,
	insertGen,
	lawOf,
	type NativeFeature,
	pairTwiceAims,
	predict,
	reportedLaw,
	sqlOf,
	startingState,
	statementOf
} from "#test/pg/direct-writers/native-errors.fixtures.ts"
import { DeskReports, Entry, Pair, writer } from "#test/pg/direct-writers/schema.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { failure, fixtureIn } from "#test/support/open-fixture.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A row check and a contract raise 23514 at the statement, under their laws, over drawn direct transactions, each case
 * on the worker's seat of the desk, its starting state written back whole first.
 *
 * Its pre-conversion budget: runs 40, coverage cases 160 (test/pg/direct-writers/native-errors.test.ts at edabdcc5f).
 */
export const aRowCheckAndAContractRaise23514AtTheStatementUnderTheirLawsOverDrawnDirectTransactions =
	property.explore(aimed(array(insertGen, { min: 1, max: 3 }), pairTwiceAims), {
		needs: { desk: Substrate.seat(deskTemplate) },
		situations: [
			"23514 at a row check",
			"23514 at a contract",
			"23505 at Pair's key",
			"23505 at Entry's key",
			"committed",
			"refused after a statement that ran"
		] satisfies ReadonlyArray<Reached<NativeFeature>>,
		check:
			({ desk: seated }, cx: Case<NativeFeature>) =>
			(inserts) =>
				Effect.scoped(
					Effect.flatMap(seated, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const f = fixtureIn(seat)
								const amount = lawNamesOf(DeskReports).contract("Amount")
								if (amount.kind === "checked") {
									assert.equal(
										lawOf(f, { kind: "domain", name: amount.domain }, amount.constraint),
										amount.law
									)
								}
								const w = yield* f.psql(writer)
								const { admin } = yield* Substrate
								/**
								 * Runs the inserts in order until one is refused: every one ran, or the first refusal and where.
								 */
								const runUntilRefused = (
									inserts: ReadonlyArray<Insert>
								): Effect.Effect<
									| { readonly kind: "ran" }
									| { readonly kind: "refused"; readonly at: number; readonly error: unknown }
								> =>
									Effect.gen(function* () {
										for (const [at, s] of inserts.entries()) {
											const ran = yield* Effect.result(w.run(sqlOf(f, s)))
											if (Result.isFailure(ran)) {
												return { kind: "refused", at, error: ran.failure } as const
											}
										}
										return { kind: "ran" } as const
									})
								const names = namesOf(f.installed)
								const stored = Effect.all({
									pairs: f.rows(
										`SELECT ${names.column(Pair, "a")}::text, ${names.column(Pair, "b")}::text FROM ${names.table(Pair)}`
									),
									entries: f.rows(
										`SELECT ${names.column(Entry, "id")}::text FROM ${names.table(Entry)}`
									)
								})
								yield* replaceRows(
									admin,
									installationGroup(namesOf(f.installed)),
									Arr.map(startingState(f), (sql) => ({ sql, params: [] }))
								)
								const before = yield* stored
								const predicted = predict(inserts)
								yield* w.begin
								const met = yield* runUntilRefused(inserts)
								if (met.kind === "refused") {
									yield* w.rollback
									const fields = pgErrorFields(met.error)
									assert.ok(fields !== undefined, String(met.error))
									assert.ok(
										predicted.kind === "fails",
										`the model commits; the writer met ${fields.code}`
									)
									assert.deepEqual(
										{ at: met.at, code: fields.code, law: reportedLaw(f, fields) },
										{ at: predicted.at, code: predicted.sqlstate, law: predicted.law }
									)
									/** Nothing a failed transaction did stays. */
									const after = yield* stored
									unorderedEqual(after.pairs, before.pairs)
									unorderedEqual(after.entries, before.entries)
									const refusedInsert = elementAt(inserts, predicted.at, "the inserts")
									cx.note(
										predicted.sqlstate === "23505"
											? refusedInsert.into === "Pair"
												? "23505 at Pair's key"
												: "23505 at Entry's key"
											: refusedInsert.into === "Pair"
												? "23514 at a row check"
												: "23514 at a contract"
									)
									if (predicted.at > 0) {
										cx.note("refused after a statement that ran")
									}
									return
								}
								yield* w.commit
								assert.ok(predicted.kind === "commits", "the model refuses; the writer committed")
								const after = yield* stored
								unorderedEqual(
									after.pairs,
									Arr.map(predicted.pairs, ([a, b]) => [String(a), String(b)])
								)
								unorderedEqual(
									after.entries,
									Arr.map(predicted.entries, (id) => [String(id)])
								)
								cx.note("committed")
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's order of refusals restated over the inserts (predict): a domain's CHECK, the row's CHECK, then the key's unique index, or the state committed"
		},
		show: Formatter.format,
		budget: { runs: 40, steered: 160 },
		kept: [],
		kills: []
	})

/**
 * Every direct write to a derived relation is refused by privilege, whichever role of the login sends it, each case on
 * the worker's seat of the desk.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/direct-writers/native-errors.test.ts at edabdcc5f).
 */
export const everyDirectWriteToADerivedRelationIsRefusedByPrivilegeWhicheverRoleOfTheLoginSendsIt =
	property.explore(
		(source) => ({ role: source.draw(element(deskRoles)), write: source.draw(derivedWriteGen) }),
		{
			needs: { desk: Substrate.seat(deskTemplate) },
			situations: [
				"INSERT refused by privilege",
				"UPDATE refused by privilege",
				"DELETE refused by privilege"
			] satisfies ReadonlyArray<Reached<`${DerivedWrite["kind"]} refused by privilege`>>,
			check:
				({ desk: seated }, c: Case<`${DerivedWrite["kind"]} refused by privilege`>) =>
				({ role: r, write }) =>
					Effect.scoped(
						Effect.flatMap(seated, (seat) =>
							Effect.provideService(
								Effect.gen(function* () {
									const f = fixtureIn(seat)
									const view = f.t("AccountEntries")
									const roleName = f.installed.role(r)
									const held = yield* f.rows(
										`SELECT pg_catalog.has_table_privilege(${quoteString(roleName)}, ${quoteString(view)}, ${quoteString(write.kind)})::text`
									)
									assert.deepEqual(
										held,
										[["false"]],
										`${roleName} holds no ${write.kind} on the derived relation`
									)
									const statement = statementOf(view, write)
									const psql = yield* f.psql(r)
									const refused = yield* failure(psql.run(statement))
									assert.equal(refused.code, "42501", statement)
									c.note(`${write.kind} refused by privilege`)
								}),
								Substrate,
								seat.substrate
							)
						)
					),
			oracle: {
				kind: "postgresql",
				name: "the role holds no privilege of the write on the derived relation (has_table_privilege), so PostgreSQL refuses it with 42501"
			},
			show: ({ role: r, write }) => `${r.name}: ${Formatter.format(write)}`,
			budget: { runs: 24, steered: 24 },
			kept: [],
			kills: []
		}
	)
