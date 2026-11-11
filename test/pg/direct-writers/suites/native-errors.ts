import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record, Result } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { type ConstraintOwner, constraintLaw } from "#compiler/ir/products.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import {
	Account,
	DeskReports,
	DistinctPair,
	desk,
	Entry,
	Pair,
	writer
} from "#test/pg/direct-writers/schema.ts"
import { bareFixture, type Fixture, failure, openFixture } from "#test/pg/e2e-laws/support.ts"
import { assert, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { lawIdOf, lawNamesOf, namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import {
	type PgErrorFields,
	pgErrorFields,
	reportedOwnerOf
} from "#test/support/substrate/errors.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The starting state, which every case's reset writes back whole: one account and one entry of it, Pair empty. */
const startingState = (f: Fixture): ReadonlyArray<string> => {
	const names = namesOf(f.installed)
	return [
		`INSERT INTO ${names.table(Account)} (${names.column(Account, "id")}, ${names.column(Account, "name")}) VALUES (1, 1)`,
		`INSERT INTO ${names.table(Entry)} (${names.column(Entry, "id")}, ${names.column(Entry, "account")}, ${names.column(Entry, "amount")}) VALUES (10, 1, 5)`
	]
}

/** The installation in its starting state, written by the owner: every law holds. */
const open = () =>
	Effect.gen(function* () {
		const f = yield* openFixture(DeskReports, [desk], bareFixture)
		yield* f.owner(startingState(f))
		return f
	})

/** The law the installation reports for a constraint, index or domain constraint name under the table or domain it
 * lives on. */
const lawOf = (
	f: Fixture,
	owner: ConstraintOwner | undefined,
	constraint: ConstraintName | undefined
): LawId | undefined =>
	constraint === undefined || owner === undefined
		? undefined
		: constraintLaw(f.installed.installation.constraintToLaw, owner, constraint)

/** The law a refusal PostgreSQL reported names: its constraint under the owner it reports. */
const reportedLaw = (f: Fixture, fields: PgErrorFields): LawId | undefined =>
	lawOf(f, reportedOwnerOf(fields), fields.constraint)

/** One direct INSERT as drawn. */
type Insert =
	| { readonly into: "Pair"; readonly a: number; readonly b: number }
	| { readonly into: "Entry"; readonly id: number; readonly amount: number }

const insertGen: Gen<Insert> = oneOf<Insert>([
	(source) => ({ into: "Pair", a: source.draw(int(0, 2)), b: source.draw(int(0, 2)) }),
	(source) => ({ into: "Entry", id: source.draw(int(10, 12)), amount: source.draw(int(-2, 5)) })
])

/** A write of the derived relation, as a direct SQL writer would send it: drawn rows, a drawn column and filters. */
type DerivedWrite =
	| {
			readonly kind: "INSERT"
			readonly rows: Arr.NonEmptyReadonlyArray<readonly [account: number, entries: number]>
	  }
	| {
			readonly kind: "UPDATE"
			readonly column: DerivedColumn
			readonly value: number
			readonly where: Option.Option<number>
	  }
	| { readonly kind: "DELETE"; readonly where: Option.Option<number> }

/** The derived relation's columns: its definition's heading. */
type DerivedColumn = "account" | "entries"

const derivedRowGen: Gen<readonly [number, number]> = (source) => [
	source.draw(int(0, 2)),
	source.draw(int(0, 2))
]

const whereGen: Gen<Option.Option<number>> = (source) =>
	source.draw(boolean) ? Option.some(source.draw(int(0, 2))) : Option.none()

const derivedWriteGen: Gen<DerivedWrite> = oneOf<DerivedWrite>([
	(source) => ({
		kind: "INSERT",
		rows: [source.draw(derivedRowGen), ...source.draw(array(derivedRowGen, { min: 0, max: 1 }))]
	}),
	(source) => ({
		kind: "UPDATE",
		column: source.draw(element(["account", "entries"] as const)),
		value: source.draw(int(0, 2)),
		where: source.draw(whereGen)
	}),
	(source) => ({ kind: "DELETE", where: source.draw(whereGen) })
])

/** The refusal the model names, or the state it commits. */
type Prediction =
	| {
			readonly kind: "fails"
			readonly at: number
			readonly law: LawId
			readonly sqlstate: "23514" | "23505"
	  }
	| {
			readonly kind: "commits"
			readonly pairs: ReadonlyArray<readonly [number, number]>
			readonly entries: ReadonlyArray<number>
	  }

type NativeFeature =
	| "23514 at a row check"
	| "23514 at a contract"
	| "23505 at Pair's key"
	| "23505 at Entry's key"
	| "committed"
	| "refused after a statement that ran"

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
export const nativeErrorsSuite = (): void =>
	layer(Substrate.layer, { excludeTestServices: true })(
		"a direct SQL writer sees PostgreSQL's native errors",
		(it) => {
			it.effect(
				"a row check and a contract raise 23514 at the statement, under their laws, over drawn direct transactions",
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const f = yield* open()
							const names = namesOf(f.installed)
							const laws = lawNamesOf(DeskReports)
							const amount = laws.contract("Amount")
							const rowCheck = lawIdOf(DeskReports, DistinctPair)
							const w = yield* f.psql(writer)
							const { admin } = yield* Substrate
							/**
							 * The row's CHECK, then the key's unique index.
							 *
							 * The domain's CHECK as the value is coerced, then the key's unique index.
							 */
							const predict = (inserts: ReadonlyArray<Insert>): Prediction => {
								const pairs: Array<readonly [number, number]> = []
								const entries: Array<number> = [10]
								/** The law an insert breaks, after the inserts before it. */
								const refusalOf = (
									s: Insert
								): Option.Option<{ readonly law: LawId; readonly sqlstate: "23514" | "23505" }> => {
									switch (s.into) {
										case "Pair":
											return s.a === s.b
												? Option.some({ law: rowCheck, sqlstate: "23514" })
												: Arr.some(pairs, ([a, b]) => a === s.a && b === s.b)
													? Option.some({ law: laws.primaryKeyLaw(Pair), sqlstate: "23505" })
													: Option.none()
										case "Entry":
											return s.amount < 0
												? Option.some({ law: amount.law, sqlstate: "23514" })
												: entries.includes(s.id)
													? Option.some({ law: laws.primaryKeyLaw(Entry), sqlstate: "23505" })
													: Option.none()
									}
								}
								for (const [at, s] of inserts.entries()) {
									const refusal = refusalOf(s)
									if (Option.isSome(refusal)) {
										return { kind: "fails", at, ...refusal.value }
									}
									if (s.into === "Pair") {
										pairs.push([s.a, s.b])
									} else {
										entries.push(s.id)
									}
								}
								return { kind: "commits", pairs, entries }
							}
							const sqlOf = (s: Insert): string =>
								s.into === "Pair"
									? `INSERT INTO ${names.table(Pair)} (${names.column(Pair, "a")}, ${names.column(Pair, "b")}) VALUES (${s.a}, ${s.b})`
									: `INSERT INTO ${names.table(Entry)} (${names.column(Entry, "id")}, ${names.column(Entry, "account")}, ${names.column(Entry, "amount")}) VALUES (${s.id}, 1, ${s.amount})`
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
										const ran = yield* Effect.result(w.run(sqlOf(s)))
										if (Result.isFailure(ran)) {
											return { kind: "refused", at, error: ran.failure } as const
										}
									}
									return { kind: "ran" } as const
								})
							const stored = Effect.all({
								pairs: f.rows(
									`SELECT ${names.column(Pair, "a")}::text, ${names.column(Pair, "b")}::text FROM ${names.table(Pair)}`
								),
								entries: f.rows(
									`SELECT ${names.column(Entry, "id")}::text FROM ${names.table(Entry)}`
								)
							})
							/** Back to the starting state, written whole (substrate/replace.ts). */
							const explored = yield* explore(
								{
									oracle: {
										kind: "specification",
										name: "PostgreSQL's order of refusals restated over the inserts (predict): a domain's CHECK, the row's CHECK, then the key's unique index, or the state committed"
									},
									suite: "direct-writers/native-errors",
									draw: drawn(array(insertGen, { min: 1, max: 3 })),
									literal: Formatter.format,
									/**
									 * Planted: one Pair inserted twice and refused at its key after a statement that ran, which a
									 * drawn transaction repeats a few times a run.
									 */
									kept: [
										{
											note: "the pair (0, 1) twice",
											sketch: [
												{ into: "Pair", a: 0, b: 1 },
												{ into: "Pair", a: 0, b: 1 }
											],
											draws: "",
											reaches: ["23505 at Pair's key", "refused after a statement that ran"]
										}
									],
									runs: 40,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									caseHang,
									coverage: required<NativeFeature>(
										[
											"23514 at a row check",
											"23514 at a contract",
											"23505 at Pair's key",
											"23505 at Entry's key",
											"committed",
											"refused after a statement that ran"
										],
										{ cases: 160, sense: notesOnly }
									)
								},
								(inserts, cx) =>
									Effect.gen(function* () {
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
										assert.ok(
											predicted.kind === "commits",
											"the model refuses; the writer committed"
										)
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
									})
							)
							if (amount.kind === "checked") {
								assert.equal(
									lawOf(f, { kind: "domain", name: amount.domain }, amount.constraint),
									amount.law
								)
							}
							return explored
						}).pipe(Effect.scoped)
					)
			)

			it.effect(
				"every direct write to a derived relation is refused by privilege, whichever role of the login sends it",
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const f = yield* open()
							const roles = nonEmpty(
								Arr.map(Record.values(desk.roles), (held) => held.role),
								"desk's roles"
							)
							const opened = yield* Effect.forEach(roles, (r) =>
								Effect.map(f.psql(r), (psql) => [r, psql] as const)
							)
							const writers = new Map(opened)
							const view = f.t("AccountEntries")
							const column = (field: DerivedColumn): string =>
								quoteIdent(identifierOf(identity.column(parsedName(field))))
							const filter = (where: Option.Option<number>): string =>
								Option.match(where, {
									onNone: () => "",
									onSome: (n) => ` WHERE ${column("account")} = ${n}`
								})
							const statementOf = (write: DerivedWrite): string => {
								switch (write.kind) {
									case "INSERT":
										return `INSERT INTO ${view} (${column("account")}, ${column("entries")}) VALUES ${Arr.join(
											Arr.map(write.rows, ([account, entries]) => `(${account}, ${entries})`),
											", "
										)}`
									case "UPDATE":
										return `UPDATE ${view} SET ${column(write.column)} = ${write.value}${filter(write.where)}`
									case "DELETE":
										return `DELETE FROM ${view}${filter(write.where)}`
								}
							}
							const roleGen = element(roles)
							return yield* explore(
								{
									suite: "direct-writers/derived-writes",
									draw: drawn((source) => ({
										role: source.draw(roleGen),
										write: source.draw(derivedWriteGen)
									})),
									literal: ({ role: r, write }) => `${r.name}: ${Formatter.format(write)}`,
									oracle: {
										kind: "postgresql",
										name: "the role holds no privilege of the write on the derived relation (has_table_privilege), so PostgreSQL refuses it with 42501"
									},
									coverage: required<`${DerivedWrite["kind"]} refused by privilege`>(
										[
											"INSERT refused by privilege",
											"UPDATE refused by privilege",
											"DELETE refused by privilege"
										],
										{ cases: 24, sense: notesOnly }
									),
									kept: [],
									runs: 24,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 8,
									caseHang
								},
								({ role: r, write }, c) =>
									Effect.gen(function* () {
										const roleName = f.installed.role(r)
										const held = yield* f.rows(
											`SELECT pg_catalog.has_table_privilege(${quoteString(roleName)}, ${quoteString(view)}, ${quoteString(write.kind)})::text`
										)
										assert.deepEqual(
											held,
											[["false"]],
											`${roleName} holds no ${write.kind} on the derived relation`
										)
										const statement = statementOf(write)
										const psql = defined(writers.get(r), `the psql child of ${r.name}`)
										const refused = yield* failure(psql.run(statement))
										assert.equal(refused.code, "42501", statement)
										c.note(`${write.kind} refused by privilege`)
									})
							)
						}).pipe(Effect.scoped)
					)
			)
		}
	)
