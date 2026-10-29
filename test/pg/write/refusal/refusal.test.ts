import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noFeatures } from "@grizzle/testing/features"
import { codePoint, element, type Gen, oneOf, string } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, pipe, String as Str } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { plainType, wildcardText } from "#compiler/scalar/compute/types.ts"
import { int8Max, int8Min } from "#compiler/scalar/values/integer.ts"
import { param, types } from "#compiler/sql/build.ts"
import { printExpr, printStatement } from "#compiler/sql/print.ts"
import {
	type ArmRefusal,
	readChangeDetail,
	readLawDetail,
	refusalDetailExpr,
	refusalFunctionDdl,
	refusalFunctionName
} from "#compiler/write/refusal.ts"
import { assert } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { expectSqlstate, inTransaction } from "#test/support/substrate/expect.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The write refusal channel on PostgreSQL 19.
 *
 * - The DETAIL expression PostgreSQL evaluates parses back to the key texts, uuid, bigint and any storable text alike,
 *   for a law's refusal and a concurrent change.
 * - The installed refusal function raises exactly its arguments: the SQLSTATE, the constraint name and the DETAIL
 *   arrive intact as the error fields the adapter classifies, for both refusal SQLSTATEs.
 * - A statement that refuses raises before it returns a row, wherever the plan evaluates its guard, so nothing after
 *   it in the transaction runs: the transaction is aborted (25P02), and a COMMIT sent after it without waiting answers
 *   ROLLBACK and leaves nothing committed. */
const textOf = (value: unknown): string => {
	if (typeof value !== "string") {
		throw new Error("a text DETAIL")
	}
	return value
}

/** An error's DETAIL; an error without one fails. */
const detailOf = (detail: Option.Option<string>): string =>
	Option.match(detail, {
		onNone: () => assert.fail("a refusal without a DETAIL"),
		onSome: (text) => text
	})

const key = [
	{ field: "employee", expr: param(1, types.uuid), type: scalarOf({ kind: "uuid" }, {}) },
	{ field: "week", expr: param(2, types.bigint), type: plainType("int8") },
	{ field: "note", expr: param(3, types.text), type: wildcardText }
] as const

/** The law a refusal names, and the constraint it raises: inputs of the codec under test, stated once and named by no
 * installation. */
const timesheetLaw = wild.lawId("timesheet_pk")
const constraint = timesheetLaw

const law: Extract<ArmRefusal, { readonly kind: "law" }> = {
	kind: "law",
	law: timesheetLaw,
	relation: "Timesheet",
	key
}

const change: Extract<ArmRefusal, { readonly kind: "change" }> = {
	kind: "change",
	reason: "PutTargetConflict",
	relation: "Timesheet",
	constraint,
	key
}

/** A letter with a combining mark after it: one user-perceived character of two scalars. */
const combined: Gen<string> = (source) =>
	`${source.draw(codePoint(0x61, 0x7a))}${source.draw(codePoint(0x03_00, 0x03_6f))}`

/**
 * Texts of up to ten characters PostgreSQL stores: printable ASCII, or any other scalar but NUL and the lone
 * surrogates, or a letter with a combining mark, so room for every delimiter, escape and quote of the DETAIL grammar
 * beside one another.
 */
const storable = string(
	oneOf([codePoint(0x20, 0x7e), codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff), combined]),
	{ min: 0, max: 10 }
)

/** One key's texts: the employee's uuid, the week's bigint and the note. */
interface KeyTexts {
	readonly employee: string
	readonly week: string
	readonly note: string
}

/** Each an exact case of the DETAIL grammar: its delimiters, escapes and quotes, and the empty text. */
const nasty: Arr.NonEmptyReadonlyArray<KeyTexts> = Arr.map(
	['"', "\\", ",", "]", "k[", "a[", "\n\t\u0001", "\u{1F600}", "'", "$$", "é", ""] as const,
	(note, i) => ({
		employee: `00000000-0000-4000-8000-${pipe(i.toString(16), Str.padStart(12, "0"))}`,
		week: (BigInt(i) - 7n).toString(),
		note
	})
)

layer(Substrate.layer)("the write refusal channel on PostgreSQL 19", (it) => {
	it.effect("the DETAIL PostgreSQL evaluates parses back to the key texts", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { admin } = yield* Substrate
				const sql = `SELECT ${printExpr(refusalDetailExpr(law))}, ${printExpr(refusalDetailExpr(change))}`
				assert.deepEqual(auditTextViolations(sql), [])
				/** Both DETAILs of one key, evaluated by PostgreSQL, parse back to the key's texts. */
				const roundTrip = ({ employee, week, note }: KeyTexts) =>
					Effect.gen(function* () {
						const rows = yield* admin.queryValues(sql, [employee, week, note])
						assert.deepEqual(readLawDetail(textOf(rows[0]?.[0])), {
							kind: "law",
							relation: "Timesheet",
							key: [
								{ field: "employee", text: employee },
								{ field: "week", text: week },
								{ field: "note", text: note }
							]
						})
						assert.deepEqual(readChangeDetail(textOf(rows[0]?.[1])), {
							reason: "PutTargetConflict",
							relation: "Timesheet"
						})
					})
				yield* exhaust(
					{
						suite: "pg/write/refusal-detail-grammar",
						generator: element(nasty),
						literal: Formatter.format,
						limit: nasty.length,
						features: noFeatures,
						caseHang: Duration.minutes(2)
					},
					roundTrip
				)
				return yield* explore(
					{
						/** Generated keys beyond the grammar's cases: 300 rotating draws. */
						suite: "pg/write/refusal-detail",
						draw: drawn((source): KeyTexts => ({
							employee: source.draw(uuid(7)),
							week: source.draw(bigint(int8Min, int8Max)).toString(),
							note: source.draw(storable)
						})),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					roundTrip
				)
			})
		)
	)

	it.effect(
		"the installed function raises its SQLSTATE, constraint and DETAIL, and the transaction commits nothing",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				for (const statement of refusalFunctionDdl(schema)) {
					yield* s.admin.query(printStatement(statement), [])
				}
				yield* s.admin.query(`CREATE TABLE "${schema}"."t" ("id" integer PRIMARY KEY)`, [])
				const call = (state: string, detail: ArmRefusal) =>
					`SELECT "${schema}"."${refusalFunctionName}"('${state}'::text, '${constraint}'::text, ${printExpr(refusalDetailExpr(detail))})`
				const values = [
					"00000000-0000-4000-8000-000000000001",
					"2911",
					'a "quoted", \\escaped\\ [note]'
				]
				const raised = (state: string, detail: ArmRefusal) =>
					Effect.gen(function* () {
						const error = yield* expectSqlstate(s.admin.query(call(state, detail), values), state)
						assert.equal(error.constraint, constraint)
						return detailOf(error.detail)
					})
				assert.equal(
					readLawDetail(yield* raised(sqlstates.integrityConstraintViolation, law)).kind,
					"law"
				)
				assert.deepEqual(
					readChangeDetail(yield* raised(sqlstates.grizzleConcurrentChange, change)),
					{
						reason: change.reason,
						relation: change.relation
					}
				)
				/** Everything sent after a refusal without waiting: the transaction is aborted, COMMIT answers ROLLBACK. */
				const session = yield* s.session({ ...ownerSession(), label: "direct" })
				yield* expectSqlstate(
					inTransaction(
						session,
						Effect.andThen(
							session.query(`INSERT INTO "${schema}"."t" VALUES (1::int4)`, []),
							session.query(call(sqlstates.integrityConstraintViolation, law), values)
						)
					),
					sqlstates.integrityConstraintViolation
				)
				yield* expectSqlstate(
					session.query(`INSERT INTO "${schema}"."t" VALUES (2::int4)`, []),
					"25P02"
				)
				const committed = yield* Effect.flip(session.commit)
				if (committed._tag !== "TransactionRolledBack") {
					return assert.fail(`COMMIT after a refusal failed with ${committed._tag}`)
				}
				assert.equal(committed.command, "ROLLBACK")
				const rows = yield* s.admin.queryValues(`SELECT count(*)::text FROM "${schema}"."t"`, [])
				assert.deepEqual(rows, [["0"]])
			})
	)
})
