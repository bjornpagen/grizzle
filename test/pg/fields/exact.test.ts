/**
 * exactInteger and exactMoney fields hold every value of their carrier, on PostgreSQL 19: each case's ledger rows, each
 * an exact integer `count` and an amount `total` of a drawn magnitude (within a signed 64-bit count, past it, or of
 * hundreds of digits, signed), are inserted through db.apply, read back, put again at new drawn values for some ids and
 * read back, their counts offset by a drawn parameter of the exact integer, doubled into Doubled by a ChangeSet member
 * whose head writes the exact sums count + count and total + total into the exact fields, and read by the owner as
 * PostgreSQL stores them. A generated field of Ledger, twice, is count + count, PostgreSQL's, and a doubled row of
 * count 1 is refused by NotOne, a row check of count + count over the exact field, naming it. Then a direct writer's fraction, value at another scale, NaN or infinity into either field is
 * refused by the column's CHECK of its scale (physical/numeric/storage.ts exactNumeric), 23514, and nothing is stored.
 *
 * Oracle: the drawn values themselves, their doubles computed on the host, and their own texts as PostgreSQL's
 * numeric_out writes them, scale 0 and money's 2, beside the specification that the column holds no other value.
 *
 * Features: each magnitude, a negative value, a put, the exact sums, the parameter, and each refusal of each field.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Option, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { Money } from "#compiler/public/fields.ts"
import { derivedLaw } from "#compiler/runtime/law-entry.ts"
import {
	Exact,
	exactInstall,
	exactTemplate,
	factOf,
	type Feature,
	Ledger,
	ledgersGen,
	refusedWrites,
	type Row,
	shownLedger,
	shownRow,
	storedTexts
} from "#test/pg/fields/exact.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const byId = Order.mapInput(Order.Number, (row: { readonly id: number }) => row.id)

/** The rows a read delivers after a case's writes: each id's last row, the restated one where a put restated it. */
const lastRows = (rows: ReadonlyArray<Row>, restated: ReadonlyArray<Row>): ReadonlyArray<Row> =>
	Arr.map(rows, (row) =>
		Option.getOrElse(
			Arr.findFirst(restated, (r) => r.id === row.id),
			() => row
		)
	)

/** The read's view of a drawn row, by value: its id, its count's digits, its total's cents and its twice's digits. */
const expectedRow = (row: Row): readonly [number, string, string, string] => [
	row.id,
	row.count.value.toString(),
	row.cents.value.toString(),
	(row.count.value * 2n).toString()
]

/** An exact field stores and reads back every drawn value bit-exactly, its exact sums among them, and refuses every other. */
export const anExactFieldStoresAndReadsBackEveryDrawnValueBitExactlyItsExactSumsAmongThemAndRefusesEveryOther =
	property.explore(ledgersGen, {
		needs: { fixture: Substrate.fresh(exactTemplate) },
		situations: [
			"a value within a signed 64-bit count",
			"a value past a signed 64-bit count",
			"a value of hundreds of digits",
			"a negative value",
			"a put restating a row",
			"a query's exact sums written into the fields",
			"a generated exact sum",
			"a count refused by its row check",
			"a parameter of the exact integer",
			...Arr.map(refusedWrites, (w): Feature => `${w.column} refusing ${w.breaks}`)
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 24, steered: 0 },
		check:
			({ fixture }, c: Case<Feature>) =>
			(d) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.scoped(
							Effect.gen(function* () {
								for (const row of d.rows) {
									for (const drawn of [row.count, row.cents]) {
										c.note(drawn.magnitude)
										if (drawn.value < 0n) {
											c.note("a negative value")
										}
									}
								}
								const o = yield* openedIn(Exact, {}, exactInstall, taken)
								const s = yield* Substrate
								const names = namesOf(o.installed)
								const last = lastRows(d.rows, d.restated)
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const stored = yield* writeAnswerOf(
										db.workload.store.once({
											params: {},
											facts: { insert: { Ledger: Arr.map(d.rows, factOf) } }
										})
									)
									assert.equal(stored._tag, "accepted", "every ledger row is written")
									const readRows = yield* rowsOf(db.workload.ledger.once({ params: {}, facts: {} }))
									const read = Arr.sort(readRows, byId)
									assert.deepEqual(
										Arr.map(read, shownLedger),
										Arr.map(d.rows, expectedRow),
										"every row reads back as written, its count and its total exactly, and its generated twice"
									)
									c.note("a generated exact sum")
									if (d.restated.length > 0) {
										const put = yield* writeAnswerOf(
											db.workload.restate.once({
												params: {},
												facts: { put: { Ledger: Arr.map(d.restated, factOf) } }
											})
										)
										assert.equal(put._tag, "accepted", "every restated row is put")
										c.note("a put restating a row")
									}
									const afterRows = yield* rowsOf(
										db.workload.ledger.once({ params: {}, facts: {} })
									)
									const after = Arr.sort(afterRows, byId)
									assert.deepEqual(
										Arr.map(after, shownLedger),
										Arr.map(last, expectedRow),
										"every row reads back at its last values"
									)
									const doubled = yield* writeAnswerOf(
										db.workload.double.once({ params: {}, facts: {} })
									)
									assert.equal(
										doubled._tag,
										"accepted",
										"the doubled rows are written from the query"
									)
									const twiceRows = yield* rowsOf(
										db.workload.doubled.once({ params: {}, facts: {} })
									)
									const twice = Arr.sort(twiceRows, byId)
									assert.deepEqual(
										Arr.map(twice, shownRow),
										Arr.map(last, (row): readonly [number, string, string] => [
											row.id,
											(row.count.value * 2n).toString(),
											(row.cents.value * 2n).toString()
										]),
										"each doubled row holds the exact sums of its row"
									)
									c.note("a query's exact sums written into the fields")
									const one = yield* writeAnswerOf(
										db.workload.judged.once({
											params: {},
											facts: {
												insert: {
													Doubled: [{ id: d.rows.length, count: 1n, total: Money.exact(d.by) }]
												}
											}
										})
									)
									if (one._tag !== "refused") {
										return assert.fail(`a count of one is refused by NotOne, not ${one._tag}`)
									}
									assert.deepEqual(
										refusedLaws(one.refused),
										[derivedLaw({ kind: "check", relation: "Doubled", name: "NotOne" })],
										"the count's refusal names NotOne, the row check over the exact field"
									)
									c.note("a count refused by its row check")
									const offsetRows = yield* rowsOf(
										db.workload.offset.once({ params: { by: d.by }, facts: {} })
									)
									const offset = Arr.sort(offsetRows, byId)
									assert.deepEqual(
										Arr.map(offset, (row) => [row.id, row.count.toString()] as const),
										Arr.map(last, (row) => [row.id, (row.count.value + d.by).toString()] as const),
										"each row's count offset by the parameter is their exact sum"
									)
									c.note("a parameter of the exact integer")
								}).pipe(
									(body) =>
										Effect.flatMap(Layer.build(o.served.layer), (context) =>
											Effect.provideContext(body, context)
										),
									Effect.scoped
								)
								const owner = yield* s.session(ownerSession())
								const table = names.table(Ledger)
								const id = names.column(Ledger, "id")
								const count = names.column(Ledger, "count")
								const total = names.column(Ledger, "total")
								const texts = yield* owner.values(
									`SELECT ${id}::text, ${count}::text, ${total}::text FROM ${table} ORDER BY ${id}`,
									[]
								)
								assert.deepEqual(
									Arr.map(texts, (row) => Arr.map(row, (cell) => String(cell))),
									Arr.map(last, (row) => [...storedTexts(row)]),
									"PostgreSQL stores each count at scale 0 and each total at money's two fraction digits"
								)
								for (const [at, write] of refusedWrites.entries()) {
									const values =
										write.column === "count"
											? `'${write.text}'::numeric, '0.00'::numeric`
											: `0::numeric, '${write.text}'::numeric`
									const attempt = yield* Effect.result(
										owner.query(
											`INSERT INTO ${table} (${id}, ${count}, ${total}) VALUES (${-1 - at}, ${values})`,
											[]
										)
									)
									const fields =
										attempt._tag === "Failure" ? pgErrorFields(attempt.failure) : undefined
									assert.equal(
										fields?.code,
										"23514",
										`a direct writer's ${write.text} into ${write.column} is refused by its column's CHECK`
									)
									c.note(`${write.column} refusing ${write.breaks}`)
								}
								const left = yield* owner.values(`SELECT count(*)::text FROM ${table}`, [])
								assert.deepEqual(
									Arr.map(left, (row) => Arr.map(row, (cell) => String(cell))),
									[[String(last.length)]],
									"no refused value is stored"
								)
							})
						),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the drawn values, their doubles and their own texts; the column holds no other value"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/numeric/storage.ts",
				original: '\tbinary("=", call("scale", [value]), lit.int(exactScale(type), types.integer))',
				replacement:
					'\tbinary(">=", call("scale", [value]), lit.int(exactScale(type), types.integer))',
				why: "An exact field's CHECK admits every scale at or above its own, so a direct writer stores 1.5 into an integer and 1.505 into an amount; the refusals fail."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\texactMoney: (v) => v.toString()",
				replacement: "\texactMoney: (v) => v.toDecimal().toString()",
				why: "An amount is written at its least scale, 12.5 where its field holds 12.50, which the column's CHECK refuses; the insert fails."
			}
		]
	})
