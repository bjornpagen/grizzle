/**
 * Every served read that states no order delivers its rows in its key's order, ascending, its key's fields in the
 * order their declaration names them, and a projection that keeps no key in its whole heading's order: whatever order
 * the table holds its rows in, after updates move them too. Text orders by code point, C.UTF-8's, as its collation is
 * stated in the read's ORDER BY.
 *
 * - **Property:** a case draws the order Item's key declares a, b and c in after its shelf, two to twelve items of
 *   distinct keys, their a, c and note texts of characters whose code point order no locale and no UTF-16 comparison
 *   keeps, and the items it updates afterwards, in an order of its own. It installs Item as `grizzle generate` drafts
 *   and serves it, inserts the items in their drawn order, so the table holds them in that physical order, reads every
 *   item, one shelf's items and the pairs of a and note, then updates the moved items in their order, each a new tuple
 *   at the end of its page, and reads all three again.
 * - **Oracle:** the ruling as a model (result-order.fixtures.ts expectedOf): each read's distinct rows sorted by its
 *   key's declared fields, the shelf the parameter fixes ordering nothing, or by the whole heading where no key is kept,
 *   texts by code point and integers numerically.
 * - **Features:** a key declared out of its fields' name order, a row moved after it was inserted, texts ordered by
 *   code point where UTF-16 differs, a shelf's read and a projection that keeps no key.
 * - **Kills:** the ORDER BY a delivered statement carries dropped, so rows come in the table's physical order; a key's
 *   fields appended in heading order, their names', where the declared order was asked.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { isRecord } from "#compiler/core/record.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce, writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import {
	caseGen,
	expectedOf,
	featuresOf,
	insertItems,
	installationOf,
	moveItems,
	type ResultOrderCase,
	type ResultOrderFeature,
	type Row,
	rowOf,
	servedOf
} from "#test/support/pg/served/result-order.fixtures.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

const situations = [
	"a key declared out of its fields' name order",
	"a row moved after it was inserted",
	"texts ordered by code point where UTF-16 differs",
	"a shelf's read, its shelf fixed",
	"a projection that keeps no key"
] as const satisfies ReadonlyArray<Reached<ResultOrderFeature>>

/** The fields each read delivers, which the model's rows hold; `sides` delivers a note on side 0 alone. */
const delivered = {
	all: ["shelf", "a", "b", "c", "note"],
	onShelf: ["a", "b", "c", "note"],
	pairs: ["a", "note"]
} as const

/** A write's read-back `items`, its rows as the outcome holds them. */
const readBackRows = (reads: unknown): ReadonlyArray<unknown> => {
	const rows = isRecord(reads) ? reads["items"] : undefined
	return Arr.isArray(rows) ? rows : assert.fail("the outcome reads its items back")
}

/** A row of `sides` as the model writes it: its group's fields, side 0's with its note. */
const sideRow = (row: unknown): Row =>
	rowOf(
		isRecord(row) && row["side"] === 0 ? ["side", "a", "b", "c", "note"] : ["side", "a", "b", "c"]
	)(row)

/** Every served read's rows come in its key's declared order, or its whole heading's, whatever the table's order. */
export const everyServedReadDeliversItsRowsInItsKeysDeclaredOrderWhateverTheTablesOrder =
	property.explore(caseGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations,
		budget: { runs: 12, steered: situations.length },
		check:
			({ substrate }, notes: Case<ResultOrderFeature>) =>
			(c: ResultOrderCase) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						for (const feature of featuresOf(c)) {
							notes.note(feature)
						}
						const generated = yield* installGenerated(installationOf(c.declared), {
							label: "result_order",
							ambient: ordinarySession
						})
						const installed = generated.installed
						yield* insertItems(installed, c.items)
						const served = servedOf(c.declared, installed.declared)
						const expected = expectedOf(c)
						yield* withServedDb(
							installed,
							served.world.server.roles.app,
							{},
							({ ctx: db, loadWithTables }) =>
								Effect.gen(function* () {
									const loaded = yield* loadWithTables(served.programs)
									const readAll = (phase: string) =>
										Effect.gen(function* () {
											for (const name of ["all", "onShelf", "pairs"] as const) {
												const answered = yield* Effect.result(
													readOnce(memberCalls(db, member(loaded.members, name)))({
														params: name === "onShelf" ? { shelf: c.shelf } : {},
														facts: {}
													})
												)
												if (Result.isFailure(answered)) {
													return assert.fail(
														`${name} answers ${phase}: ${Formatter.format(answered.failure)}`
													)
												}
												assert.deepEqual(
													Arr.map(answered.success, rowOf(delivered[name])),
													expected[name],
													`${name} delivers its rows in its key's declared order ${phase}`
												)
											}
										})
									/** A union of two heading groups keyed by the fields they share: by side, then its key in declared order. */
									const readSides = (phase: string) =>
										Effect.gen(function* () {
											const answered = yield* Effect.result(
												readOnce(memberCalls(db, member(loaded.members, "sides")))({
													params: {},
													facts: {}
												})
											)
											if (Result.isFailure(answered)) {
												return assert.fail(
													`sides answers ${phase}: ${Formatter.format(answered.failure)}`
												)
											}
											assert.deepEqual(
												Arr.map(answered.success, sideRow),
												expected.sides,
												`sides delivers its rows by side, then its key's declared order ${phase}`
											)
										})
									yield* readAll("as inserted")
									yield* readSides("as inserted")
									yield* moveItems(installed, c)
									yield* readAll("after its rows moved")
									yield* readSides("after its rows moved")
									/** A ChangeSet's read-back leaves the database in its key's order, as a read does. */
									const stocked = yield* writeAnswerOf(
										writeOnce(memberCalls(db, member(loaded.members, "stock")))({
											params: {},
											facts: { insert: { Item: [c.stocked] } }
										})
									)
									if (stocked._tag !== "accepted") {
										return assert.fail(`the stocking write is accepted, not ${stocked._tag}`)
									}
									assert.deepEqual(
										Arr.map(readBackRows(stocked.reads), rowOf(delivered.all)),
										expected.stocked,
										"the read-back delivers its rows in its key's declared order"
									)
								})
						)
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "each read's rows sorted by its key's declared fields, or its whole heading where it keeps no key, texts by code point"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/template.ts",
				original:
					"\t\t\t{ ...ast, body: plain, orderBy: collatedOrder(ast.orderBy, plain.targets, output.heading) },",
				replacement: "\t\t\t{ ...ast, body: plain, orderBy: [] },",
				why: "A delivered statement orders nothing: every read's rows come in the table's physical order, its insertion order and then its moved rows last."
			},
			{
				file: "packages/engine/src/logical/key-order.ts",
				original:
					"\t\t\treturn rest.every((order) => order.every((c, at) => c === first[at])) ? first : columns",
				replacement: "\t\t\treturn columns",
				why: "A union's key fields are appended in heading order, their names', not as its arms' declared key orders them (logical/key-order.ts unionOfRows): sides, keyed over the fields its groups share, comes in a, b, c order."
			},
			{
				file: "packages/engine/src/logical/order.ts",
				original: "\tfor (const name of subject.keyOrder(remaining)) {",
				replacement: "\tfor (const name of remaining) {",
				why: "A heading that is its own key is completed in heading order, its names', not its key's declared order (logical/order.ts completeFrom step 3): sides, whose fields its groups share are its key, comes in a, b, c order."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\tcase "readBack":\n\t\t\treturn order.kind === "none" ? { keys: [], at } : order.stated\n\t\tcase "region":',
				replacement:
					'\t\t\treturn order.kind === "none" ? { keys: [], at } : order.stated\n\t\tcase "readBack":\n\t\tcase "region":',
				why: "A ChangeSet's read-back that states no order is delivered unordered (check/checker.ts rootOrder), in its plan's order: the read-back comes in the table's physical order."
			},
			{
				file: "packages/engine/src/logical/order.ts",
				original: "\t\tfor (const c of subject.keyOrder(chosen.additional)) {",
				replacement: "\t\tfor (const c of chosen.additional) {",
				why: "A key's fields are appended in heading order, their names', so a key declared (shelf, c, a, b) orders its reads by a, b, c."
			}
		]
	})
