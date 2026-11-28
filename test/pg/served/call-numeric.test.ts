/**
 * A declared function of PostgreSQL's numeric of no typmod, `numeric`, passes its value as it is through a query's
 * read and a write, as a stored `numeric` field does, and arithmetic over one is held to numeric's own limit by
 * PostgreSQL alone.
 *
 * - **Property:** a case draws decimals, among them 0.17 (QTI's round-to of 7/40, which a typmod of scale 0 reads as
 *   0), values past 1e300 and below 1e-300, numeric's widest integer and finest fraction, NaN and the infinities, each
 *   a Source row's text. The served ChangeSet `hold` writes each as a Numeric into Held's `numeric`, and `record`
 *   writes each Source's `decimalOf(text)`, a call returning numeric, into Written's. Then `fromText` reads each
 *   decimalOf, `held` each Held value and its `negated`, a call of a numeric argument and result, and `written`
 *   Written's rows: each is the drawn value exactly, its negation numeric_uminus's. `doubled` reads each Held value
 *   added to itself, compiled with no guard: numeric_add's sum where every sum lies within numeric's format, and
 *   otherwise its statement refused by PostgreSQL with SQLSTATE 22003, numeric_value_out_of_range.
 * - **Oracle:** the host Numeric model: the host's parse of each text (scalar/values/decimal.ts Numeric.fromString),
 *   numeric.c's numeric_uminus and numeric_add (scalar/compute/numeric.ts), none past numeric's format.
 * - **Features:** each kind of drawn decimal, and a sum past numeric's format refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { memberExplains, memberCalls } from "#adapter/db/handles.ts"
import { isRecord } from "#compiler/core/record.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { Numeric } from "#compiler/public/fields.ts"
import {
	caseGen,
	doubledModel,
	factsOf,
	heldFacts,
	modelOf,
	negatedModel,
	type NumericCase,
	type NumericFeature,
	numericTemplate,
	programsOf,
	worldOf
} from "#test/pg/served/call-numeric.fixtures.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type Feature = NumericFeature | "a sum past numeric's format refused" | "every sum answered"

const features = [
	"a fraction a scale-0 typmod would round away (7/40 as 0.17)",
	"a value past 1e300",
	"a value below 1e-300",
	"numeric's widest integer, whose double PostgreSQL refuses with 22003",
	"numeric's finest fraction",
	"NaN",
	"an infinity",
	"an ordinary decimal",
	"a sum past numeric's format refused",
	"every sum answered"
] as const satisfies ReadonlyArray<Reached<Feature>>

/** A row's column `key` as the model's Numeric reads it, by its one text, or how it is no Numeric. */
const decimalAt = (row: unknown, key: string): string => {
	if (!isRecord(row)) {
		return "not a row"
	}
	const value = row[key]
	return value instanceof Numeric ? value.text : `not a Numeric: ${typeof value}`
}

/** A row's id. */
const idOf = (row: unknown): number =>
	isRecord(row) && typeof row["id"] === "number" ? row["id"] : -1

/** The rows of a read by id, each column `key`'s Numeric text. */
const byId = (
	rows: ReadonlyArray<unknown>,
	key: string
): ReadonlyArray<readonly [number, string]> =>
	Arr.sort(
		Arr.map(rows, (row) => [idOf(row), decimalAt(row, key)] as const),
		(a: readonly [number, string], b: readonly [number, string]) =>
			a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
	)

/** The model's rows by id: each drawn value's image under `f`, as its one text. */
const modelById = (
	c: NumericCase,
	f: (d: Numeric) => Numeric
): ReadonlyArray<readonly [number, string]> =>
	Arr.map(c.drawn, (d, id) => [id, f(modelOf(d.text)).text] as const)

/** A declared function of numeric of no typmod passes its value as it is, and a bare numeric's arithmetic is PostgreSQL's. */
export const aCallOfANumericOfNoTypmodPassesItsValueAsItIsThroughReadsAndWrites = property.explore(
	caseGen,
	{
		needs: Substrate.oneOf({ numeric: numericTemplate }, Substrate.fresh),
		situations: features,
		budget: { runs: 16, steered: features.length },
		check: (templates, notes: Case<Feature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					for (const d of c.drawn) {
						notes.note(d.feature)
					}
					const taken = yield* templates.numeric
					yield* Effect.provideService(
						Effect.gen(function* () {
							const installed = taken.value.installed
							yield* loadMigrated(installed, factsOf(c))
							const world = worldOf(installed.declared)
							yield* withServedDb(
								installed,
								world.server.roles.app,
								{},
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(programsOf(installed.declared))
										const call = (name: string) => memberCalls(db, member(loaded.members, name))
										const none = { params: {}, facts: {} }
										const held = yield* Effect.result(
											writeOnce(call("hold"))({
												params: {},
												facts: { insert: { Held: heldFacts(c) } }
											})
										)
										assert.ok(
											Result.isSuccess(held),
											`hold writes each Numeric: ${Formatter.format(held)}`
										)
										const recorded = yield* Effect.result(writeOnce(call("record"))(none))
										assert.ok(
											Result.isSuccess(recorded),
											`record writes each call's value: ${Formatter.format(recorded)}`
										)
										const read = (name: string) =>
											Effect.map(Effect.result(readOnce(call(name))(none)), (answered) =>
												Result.isSuccess(answered)
													? answered.success
													: assert.fail(`${name} answers: ${Formatter.format(answered.failure)}`)
											)
										const identity = (d: Numeric) => d
										const fromText = yield* read("fromText")
										assert.deepEqual(
											byId(fromText, "of"),
											modelById(c, identity),
											"decimalOf returns each text's value exactly"
										)
										const heldRows = yield* read("held")
										assert.deepEqual(
											byId(heldRows, "value"),
											modelById(c, identity),
											"a numeric field holds each written Numeric exactly"
										)
										assert.deepEqual(
											byId(heldRows, "negated"),
											modelById(c, negatedModel),
											"negated takes and returns each value exactly"
										)
										const written = yield* read("written")
										assert.deepEqual(
											byId(written, "value"),
											modelById(c, identity),
											"a call's value is written exactly"
										)
										const sums = Arr.map(c.drawn, (d) => doubledModel(modelOf(d.text)))
										const doubled = yield* Effect.result(readOnce(call("doubled"))(none))
										if (Arr.some(sums, Option.isNone)) {
											notes.note("a sum past numeric's format refused")
											assert.ok(Result.isFailure(doubled), "a sum past numeric's format is refused")
											const explains = memberExplains(
												db,
												loaded.tables,
												member(loaded.members, "doubled")
											)
											if (explains.kind !== "read") {
												return assert.fail("a read explains as a read")
											}
											const ran = yield* Effect.result(explains.explainAnalyze(none))
											assert.ok(
												Result.isFailure(ran) &&
													ran.failure._tag === "ReadFailure" &&
													ran.failure.reason._tag === "ServerError" &&
													ran.failure.reason.sqlstate === sqlstates.numericValueOutOfRange,
												`its statement raises numeric_value_out_of_range: ${Formatter.format(ran)}`
											)
											return
										}
										if (Result.isFailure(doubled)) {
											return assert.fail(`doubled answers: ${Formatter.format(doubled.failure)}`)
										}
										notes.note("every sum answered")
										assert.deepEqual(
											byId(doubled.success, "twice"),
											Arr.map(
												sums,
												(s, id) =>
													[
														id,
														Option.match(s, { onNone: () => "none", onSome: (d) => d.text })
													] as const
											),
											"doubled answers numeric_add's sums"
										)
									})
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "specification",
			name: "the host Numeric model: each text's parse, numeric_uminus and numeric_add"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/physical.ts",
				original: "\t\t\treturn b.typmod === undefined\n\t\t\t\t? types.numeric\n",
				replacement: "\t\t\treturn b.typmod === undefined\n\t\t\t\t? numericType(1000, 0)\n",
				why: "numeric of no typmod is cast and stored as numeric(1000, 0), the typmod edullm's declaration had to state: a call's 0.17 reads as 0, and every fraction a field holds is rounded away."
			},
			{
				file: "packages/engine/src/scalar/values/fault.ts",
				original:
					"\tneeded > numericMaxIntegerDigits && operands.some((digits) => digits >= numericMaxIntegerDigits)\n",
				replacement: "\tfalse\n",
				why: "A sum over a numeric is ResourceBound, its operand's bound numeric's own limit: the schema's doubled refuses to compile, where PostgreSQL holds the sum to that limit itself."
			}
		]
	}
)
