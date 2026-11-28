/**
 * The stored kinds a records relation keeps of a read, on PostgreSQL 19 (stored-kinds.fixtures.ts): a search document
 * stored as a read delivered it (tsvector), an instant stored as it is (instant.stored), the database drawing
 * nothing, and a computed numeric of a bound (numeric.within). Over drawn rows, each written into Source by a direct
 * writer, a document of drawn text, repeats, disorder and repeated positions among them, as tsvectorin stores it, an
 * instant of drawn microseconds up to bigint's top and an amount about Kept's bound or a special, the case reads Source
 * through grizzle and stores what it read in Kept through the served workload:
 *
 * - every row whose amount lies within the bound is inserted as it was read and read back exactly, its instant's
 *   microseconds, its document's text, lexemes, positions and weights, and its amount; one past the bound is refused
 *   before any SQL (EncodingFailure numericBound), never rounded;
 * - a put of Kept's rows each with another row's document, by its key of its id and its stored instant, reads back so;
 * - a query fills Copied from Source, its instants and documents stated by the terms it reads, which read back as
 *   Source holds them;
 * - PostgreSQL holds Kept's every value as Source's, each amount by its value (trim_scale), and the column's CHECK
 *   refuses a direct writer's amount past the bound (23514).
 *
 * Oracle: Source's rows as PostgreSQL holds them, read as text in the case's own session, each document's text the
 * unit model's of the drawn text (search-document.fixtures.ts stored, printed), and each amount within the bound by
 * the bound's rule (withinKept).
 *
 * Features: an amount within and past the bound, a special amount, an empty document, a document written out of its
 * one form, an instant of bigint's top, a put of another row's document and a direct writer's amount past the bound.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	amountText,
	documentTexts,
	Kept,
	Source,
	type StoredCase,
	type StoredFeature,
	storedCaseGen,
	storedInstall,
	storedTemplate,
	Stored,
	withinKept
} from "#test/pg/fields/stored-kinds.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

const byId = Order.mapInput(Order.Number, (row: { readonly id: number }) => row.id)

/** Each stored kind is written and read back exactly as a read delivered it, a computed numeric past its bound refused before any SQL and by its column's CHECK. */
export const eachStoredKindIsWrittenAndReadBackExactlyAsAReadDeliveredItAComputedNumericPastItsBoundRefusedBeforeAnySQLAndByItsColumnsCheck =
	property.explore(storedCaseGen, {
		needs: { fixture: Substrate.fresh(storedTemplate) },
		situations: [
			"an amount within the bound kept",
			"an amount past the bound refused",
			"a special amount kept",
			"an empty document",
			"a document out of its one form written",
			"an instant of bigint's top",
			"a put of another row's document",
			"a direct writer's amount past the bound refused"
		] satisfies ReadonlyArray<Reached<StoredFeature>>,
		budget: { runs: 12, steered: 24 },
		check:
			({ fixture }, c: Case<StoredFeature>) =>
			(d: StoredCase) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.scoped(
							Effect.gen(function* () {
								const o = yield* openedIn(Stored, {}, storedInstall, taken)
								const s = yield* Substrate
								const owner = yield* s.session(ownerSession())
								const names = namesOf(o.installed)
								const column = (
									r: typeof Source | typeof Kept,
									f: "id" | "at" | "doc" | "amount"
								): string => names.column(r, f)
								yield* owner.begin
								for (const [id, row] of d.rows.entries()) {
									const texts = documentTexts(row)
									if (texts.raw === "") {
										c.note("an empty document")
									}
									if (texts.raw !== texts.stored) {
										c.note("a document out of its one form written")
									}
									if (row.at === 9_223_372_036_854_775_807n) {
										c.note("an instant of bigint's top")
									}
									yield* owner.query(
										`INSERT INTO ${names.table(Source)} (${column(Source, "id")}, ${column(Source, "at")}, ${column(Source, "doc")}, ${column(Source, "amount")}) VALUES ($1::integer, $2::bigint, $3::text::tsvector, $4::numeric)`,
										[String(id), String(row.at), texts.raw, amountText(row.amount)]
									)
								}
								yield* owner.commit
								const held = (table: string, r: typeof Source | typeof Kept) =>
									owner.values(
										`SELECT ${column(r, "id")}::text, ${column(r, "at")}::text, ${column(r, "doc")}::text, trim_scale(${column(r, "amount")})::text FROM ${table} ORDER BY ${column(r, "id")}`,
										[]
									)
								const source = yield* held(names.table(Source), Source)
								assert.deepEqual(
									Arr.map(source, (cells) => cells[2]),
									Arr.map(d.rows, (row) => documentTexts(row).stored),
									"PostgreSQL stores each drawn document as the model's one form of it"
								)
								const within = new Set(
									Arr.flatMap(d.rows, (row, id) => (withinKept(row.amount) ? [id] : []))
								)
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const sourced = yield* rowsOf(db.workload.sources.once({ params: {}, facts: {} }))
									const read = Arr.sort(sourced, byId)
									const keep = Arr.filter(read, (row) => within.has(row.id))
									for (const row of read) {
										const drawn = defined(d.rows[row.id], "a read row's drawn row")
										if (within.has(row.id)) {
											c.note(
												drawn.amount.kind === "special"
													? "a special amount kept"
													: "an amount within the bound kept"
											)
											continue
										}
										c.note("an amount past the bound refused")
										const refused = yield* Effect.result(
											db.workload.keep.once({ params: {}, facts: { insert: { Kept: [row] } } })
										)
										assert.ok(
											Result.isFailure(refused) &&
												refused.failure.kind === "input" &&
												Str.includes("refused: numericBound")(refused.failure.message),
											"an amount past the bound is refused before any SQL, never rounded"
										)
									}
									if (keep.length > 0) {
										const kept = yield* writeAnswerOf(
											db.workload.keep.once({ params: {}, facts: { insert: { Kept: keep } } })
										)
										assert.equal(kept.kind, "accepted", "every row within the bound is kept")
									}
									const keptRows = yield* rowsOf(db.workload.kept.once({ params: {}, facts: {} }))
									const back = Arr.sort(keptRows, byId)
									assert.deepEqual(
										Arr.map(back, (row) => [row.id, row.at, row.doc, row.amount.text]),
										Arr.map(keep, (row) => [row.id, row.at, row.doc, row.amount.text]),
										"every kept row reads back as it was read"
									)
									const [first, ...others] = keep
									if (d.rekeyed && first !== undefined && others.length > 0) {
										c.note("a put of another row's document")
										const rotated = Arr.map(keep, (row, i) => ({
											...row,
											doc: defined(keep[(i + 1) % keep.length], "the next row").doc
										}))
										const put = yield* writeAnswerOf(
											db.workload.rekeep.once({ params: {}, facts: { put: { Kept: rotated } } })
										)
										assert.equal(put.kind, "accepted", "the put is accepted")
										const putRows = yield* rowsOf(db.workload.kept.once({ params: {}, facts: {} }))
										const after = Arr.sort(putRows, byId)
										assert.deepEqual(
											Arr.map(after, (row) => [row.id, row.at, row.doc]),
											Arr.map(rotated, (row) => [row.id, row.at, row.doc]),
											"each row reads back with the document its put gave it"
										)
									}
									const copy = yield* writeAnswerOf(
										db.workload.copy.once({ params: {}, facts: {} })
									)
									assert.equal(copy.kind, "accepted", "Copied is filled from Source")
									const copiedRows = yield* rowsOf(
										db.workload.copied.once({ params: {}, facts: {} })
									)
									const copied = Arr.sort(copiedRows, byId)
									assert.deepEqual(
										Arr.map(copied, (row) => [row.id, row.at, row.doc]),
										Arr.map(read, (row) => [row.id, row.at, row.doc]),
										"a query's copy of Source's instants and documents reads back as Source holds them"
									)
								}).pipe(Effect.scoped, withLayer(o.served.layer))
								const keptHeld = yield* held(names.table(Kept), Kept)
								if (!d.rekeyed) {
									assert.deepEqual(
										keptHeld,
										Arr.filter(source, (cells) => within.has(Number(cells[0]))),
										"PostgreSQL holds each kept row's values as Source holds them"
									)
								}
								yield* owner.begin
								const past = yield* Effect.result(
									owner.query(
										`INSERT INTO ${names.table(Kept)} (${column(Kept, "id")}, ${column(Kept, "at")}, ${column(Kept, "doc")}, ${column(Kept, "amount")}) VALUES (-1, 0, ''::tsvector, $1::numeric)`,
										["1000000"]
									)
								)
								yield* owner.rollback
								assert.ok(
									Result.isFailure(past) &&
										past.failure.reason._tag === "ServerError" &&
										past.failure.reason.fields.code === "23514",
									"the column's CHECK refuses a direct writer's amount past the bound"
								)
								c.note("a direct writer's amount past the bound refused")
							})
						),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "Source's rows as PostgreSQL holds them, each document the unit model's one form of the drawn text, each amount judged by the bound's rule"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: '\t\tif (searchedOnly(type) && w.kind !== "generated" && w.kind !== "caller") {',
				replacement: '\t\tif (searchedOnly(type) && w.kind !== "generated") {',
				why: "A search document its caller writes is refused, as before tsvector: Source and Kept do not compile."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: '\t\t\tcase "caller":\n\t\t\t\treturn callerWriting\n\t\t\tcase "instant":',
				replacement:
					'\t\t\tcase "caller":\n\t\t\t\treturn isInstantDesc(f.desc) ? instantWriting : callerWriting\n\t\t\tcase "instant":',
				why: "A stored instant is the database's clock again, so no row states it: the stored kinds do not compile or their rows are refused."
			},
			{
				file: "packages/engine/src/physical/numeric/storage.ts",
				original: "\t\treturn bound === undefined ? lit.bool(true) : boundPredicate(column, bound)",
				replacement: "\t\treturn lit.bool(true)",
				why: "The column's CHECK holds every numeric, so a direct writer's amount past the bound is stored."
			}
		]
	})
