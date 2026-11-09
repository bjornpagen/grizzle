import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, element, type Gen, oneOf, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { readChangeDetail, readLawDetail } from "#compiler/runtime/write/refusal.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { param, types } from "#compiler/sql/build.ts"
import { printExpr, printStatement } from "#compiler/sql/print.ts"
import {
	type ArmRefusal,
	raised as raisedBy,
	refusalFunctionDdl,
	refusalFunctionName
} from "#compiler/write/refusal.ts"
import { assert } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { outputText } from "#test/support/wire.ts"

/** An error's DETAIL; an error without one fails. */
const detailOf = (detail: Option.Option<string>): string =>
	Option.match(detail, {
		onNone: () => assert.fail("a refusal without a DETAIL"),
		onSome: (text) => text
	})

/** The write refusal channel on PostgreSQL 19: the installed refusal function raises exactly its arguments, the
 * SQLSTATE, the constraint name and the DETAIL PostgreSQL evaluates, which arrive intact as the error fields the adapter
 * classifies, for both refusal SQLSTATEs, and the DETAIL parses back to the key texts, uuid, bigint and any storable
 * text alike, for a law's refusal and a concurrent change. The key's three fields: a uuid, a bigint and a text. */
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

/** The DETAIL grammar's delimiters, escapes and quotes, and the empty text, drawn as notes beside the storable ones. */
const grammarEdges = [
	'"',
	"\\",
	",",
	"]",
	"k[",
	"a[",
	"\n\t\u0001",
	"\u{1F600}",
	"'",
	"$$",
	"é",
	""
] as const

const note: Gen<string> = weighted([
	[3, storable],
	[1, element(grammarEdges)]
])

/** A refusal the installed function raises: its SQLSTATE and the DETAIL a law's refusal or a concurrent change makes. */
type Raised = "a law's refusal" | "a concurrent change"

const raisedFeatures: Arr.NonEmptyReadonlyArray<Raised> = ["a law's refusal", "a concurrent change"]

layer(Substrate.layer)("the write refusal channel on PostgreSQL 19", (it) => {
	it.effect(
		"the installed function raises its SQLSTATE and constraint, and a DETAIL PostgreSQL evaluates that parses back to the key texts",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					for (const statement of refusalFunctionDdl(schema)) {
						yield* s.admin.query(printStatement(statement), [])
					}
					const sql = (refusal: ArmRefusal) =>
						`SELECT "${schema}"."${refusalFunctionName}"($4::text, $5::text, ${printExpr(raisedBy(refusal).detail)})`
					assert.deepEqual(auditTextViolations(sql(law)), [])
					assert.deepEqual(auditTextViolations(sql(change)), [])
					/** One key's refusal raised through the installed function: the error PostgreSQL reports carries its SQLSTATE,
					 * its constraint and its DETAIL, which parses back to the key's texts. */
					const raised = ({ employee, week, note }: KeyTexts, kind: Raised) =>
						Effect.gen(function* () {
							const state =
								kind === "a law's refusal"
									? sqlstates.integrityConstraintViolation
									: sqlstates.grizzleConcurrentChange
							const error = yield* expectSqlstate(
								s.admin.query(sql(kind === "a law's refusal" ? law : change), [
									employee,
									week,
									note,
									state,
									constraint
								]),
								state
							)
							assert.equal(error.constraint, constraint)
							const detail = detailOf(error.detail)
							if (kind === "a law's refusal") {
								assert.deepEqual(readLawDetail(detail), {
									kind: "law",
									relation: "Timesheet",
									key: [
										{ field: "employee", text: outputText(employee) },
										{ field: "week", text: outputText(week) },
										{ field: "note", text: outputText(note) }
									]
								})
							} else {
								assert.deepEqual(readChangeDetail(detail), {
									reason: "PutTargetConflict",
									relation: "Timesheet"
								})
							}
						})
					return yield* explore(
						{
							suite: "pg/write/refusal-detail",
							draw: drawn(
								(source) =>
									[
										{
											employee: source.draw(uuid(7)),
											week: source.draw(bigint(int8Min.value, int8Max.value)).toString(),
											note: source.draw(note)
										},
										source.draw(element(raisedFeatures))
									] as const
							),
							literal: Formatter.format,
							coverage: required<Raised>(raisedFeatures, { cases: 40, sense: notesOnly }),
							kept: [],
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
							oracle: { kind: "universal", name: "read ∘ raise = id" }
						},
						([texts, kind], c) =>
							Effect.gen(function* () {
								c.note(kind)
								yield* raised(texts, kind)
							})
					)
				})
			)
	)
})
