/**
 * A text column's array parameter, which travels as a binary text[] of its values' UTF-8 bytes (codec/bytea.ts
 * textArray), on PostgreSQL 19: every text a write's insert, put and delete slots carry, and every text a read's
 * relation parameter carries, reaches PostgreSQL as the very text the host holds, as the literal array it replaced
 * delivered it.
 *
 * The schema is two mutable relations of a key and a text of any characters, Note and Response, the second written as
 * edullm writes a child's answers, from a relation parameter. A case is a list of texts, each drawn from the characters
 * a literal array quotes or escapes (quotes, backslashes, braces, commas, white space, the text NULL), every plane's
 * scalars (multibyte and astral, Cyrillic, Hebrew and Arabic among them), the empty text, texts of 53 to 1200 units
 * with a scalar of U+0400 to U+07FF throughout or near their end, and long texts. It inserts one Note per text, reads
 * them back, puts each row's text reversed, reads them back, deletes the rows at even keys by their facts, reads the
 * rest back, reads the texts back through a relation parameter, and writes one Response per text from a relation
 * parameter and reads them back.
 *
 * Node's TextEncoder.encodeInto underfilled a destination of exactly a text's UTF-8 length when the text held a scalar
 * of U+0400 to U+07FF and was 53 units or longer (nodejs/node#65994), which left 0x00 bytes in a binary text[] element;
 * its failing lengths are not contiguous, so such texts are kept: a child's Cyrillic answer ending in U+0400, a Hebrew
 * one ending in a Hebrew letter, and six texts at lengths where it underfilled on Node v26.13.0 (upstream/node).
 *
 * The oracle is the literal path the binary array replaced (codec/recordset.ts textArrayParam): each read gives exactly
 * the texts PostgreSQL stores from the text array literal of the texts written, compared as JavaScript strings.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter, Array as Arr, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { textArrayParam } from "#compiler/codec/recordset.ts"
import {
	features,
	holdsTwoByteRange,
	reversed,
	sorted,
	textCases,
	type TextFeature,
	Texts,
	textsInstall,
	textsTemplate
} from "#test/pg/write/text-arrays/text-arrays.fixtures.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Carries every text a write's slots or a read's relation parameter hold to PostgreSQL as the text the host holds, each
 * case on a clone of Texts of its own, installed once per member, opening its own Db, where the search shared one Db
 * across its cases.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/write/text-arrays/text-arrays.test.ts at 8d892899f).
 */
export const carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds =
	property.explore(textCases, {
		needs: { fresh: Substrate.fresh(textsTemplate) },
		situations: features satisfies ReadonlyArray<Reached<TextFeature>>,
		check:
			({ fresh }, c: Case<TextFeature>) =>
			(texts) =>
				Effect.scoped(
					Effect.flatMap(fresh, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Texts, {}, textsInstall, taken)
								const s = yield* Substrate
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const bodies = Effect.map(
										rowsOf(db.workload.notes.once({ params: {}, facts: {} })),
										(rows) => sorted(Arr.map(rows, (row) => row.body))
									)
									const values = Effect.map(
										rowsOf(db.workload.recorded.once({ params: {}, facts: {} })),
										(rows) => sorted(Arr.map(rows, (row) => row.value))
									)
									/** The texts PostgreSQL reads from the text array literal of `written`, in code unit order. */
									const literal = (written: ReadonlyArray<string>) =>
										Effect.map(
											Effect.orDie(
												s.admin.queryValues("SELECT pg_catalog.unnest($1::pg_catalog.text[])", [
													textArrayParam(written)
												])
											),
											(stored) =>
												sorted(
													Arr.map(stored, (row) => {
														const t = defined(row[0], "an unnested element")
														return typeof t === "string"
															? t
															: assert.fail(`a text element, not ${typeof t}`)
													})
												)
										)
									const rows = Arr.map(texts, (body, i) => ({ id: uuidOf(i + 1), body }))
									const inserted = yield* writeAnswerOf(
										db.workload.insertNote.once({ params: {}, facts: { insert: { Note: rows } } })
									)
									assert.equal(inserted._tag, "accepted", "the insert is accepted")
									const afterInsert = yield* bodies
									const insertedLiteral = yield* literal(texts)
									assert.deepEqual(afterInsert, insertedLiteral, "the inserted texts read back")
									const put = Arr.map(rows, (row) => ({ id: row.id, body: reversed(row.body) }))
									const putOutcome = yield* writeAnswerOf(
										db.workload.putNote.once({ params: {}, facts: { put: { Note: put } } })
									)
									assert.ok(
										putOutcome._tag === "accepted" || putOutcome._tag === "unchanged",
										`the put is lawful, not ${putOutcome._tag}`
									)
									const afterPut = yield* bodies
									const putLiteral = yield* literal(Arr.map(put, (row) => row.body))
									assert.deepEqual(afterPut, putLiteral, "the put texts read back")
									const deleted = Arr.filter(put, (_, i) => i % 2 === 1)
									const kept = Arr.filter(put, (_, i) => i % 2 === 0)
									const deletedOutcome = yield* writeAnswerOf(
										db.workload.deleteNote.once({
											params: {},
											facts: { delete: { Note: deleted } }
										})
									)
									assert.ok(
										deletedOutcome._tag === "accepted" || deletedOutcome._tag === "unchanged",
										`the delete is lawful, not ${deletedOutcome._tag}`
									)
									const afterDelete = yield* bodies
									const keptLiteral = yield* literal(Arr.map(kept, (row) => row.body))
									assert.deepEqual(
										afterDelete,
										keptLiteral,
										"the delete removes exactly the facts it names"
									)
									const echoRows = Arr.map(texts, (body) => ({ body }))
									const echoes = yield* rowsOf(
										db.workload.echoed.once({ params: { rows: echoRows }, facts: {} })
									)
									const echoedLiteral = yield* literal(Arr.dedupe(texts))
									assert.deepEqual(
										sorted(Arr.map(echoes, (row) => row.body)),
										echoedLiteral,
										"a relation parameter's texts read back"
									)
									const responses = Arr.map(texts, (value, i) => ({ id: uuidOf(i + 1), value }))
									const answeredOutcome = yield* writeAnswerOf(
										db.workload.answer.once({ params: { responses }, facts: {} })
									)
									assert.equal(
										answeredOutcome._tag,
										"accepted",
										"the write from a relation parameter is accepted"
									)
									const afterAnswers = yield* values
									assert.deepEqual(
										afterAnswers,
										insertedLiteral,
										"a relation parameter's written texts read back"
									)
									const all = Arr.join(texts, "")
									/** Whether the texts hold any of `points`. */
									const holdsAny = (points: ReadonlyArray<string>): boolean =>
										Arr.some(points, (point) => Str.includes(point)(all))
									if (holdsAny(['"', "\\"])) {
										c.note("a quote or a backslash")
									}
									if (holdsAny(["{", "}", ","])) {
										c.note("a brace or a comma")
									}
									if (Arr.some(texts, (t) => Str.toUpperCase(t) === "NULL")) {
										c.note("the text NULL")
									}
									if (Arr.some(Arr.fromIterable(all), (point) => point.length === 2)) {
										c.note("an astral scalar")
									}
									if (Arr.some(texts, (t) => t === "")) {
										c.note("the empty text")
									}
									if (Arr.some(texts, (t) => t.length >= 2 ** 12)) {
										c.note("a long text")
									}
									if (Arr.some(texts, (t) => t.length >= 53 && holdsTwoByteRange(t))) {
										c.note("a text of 53 units or more holding U+0400 to U+07FF")
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the texts PostgreSQL stores from the text array literal of the texts written"
		},
		show: Formatter.format,
		budget: { runs: 40, steered: 40 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/text-arrays/text-arrays.test.ts#carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds:-:1"
				),
				reason:
					"a child's Cyrillic answer of 281 units ending in U+0400, which encodeInto wrote two bytes short",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/pg/write/text-arrays/text-arrays.test.ts#carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds:-:2"
				),
				reason:
					"a child's Hebrew answer of 271 units ending in a Hebrew letter, which encodeInto wrote two bytes short",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/pg/write/text-arrays/text-arrays.test.ts#carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds:-:3"
				),
				reason: "nodejs/node#65994 on Node v26.13.0: U+0400 x 258 then 'a'",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/pg/write/text-arrays/text-arrays.test.ts#carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds:-:4"
				),
				reason: "nodejs/node#65994 on Node v26.13.0: U+0400 x 263 then 'a'",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/pg/write/text-arrays/text-arrays.test.ts#carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds:-:5"
				),
				reason: "nodejs/node#65994 on Node v26.13.0: U+0400 x 317 then 'a'",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/pg/write/text-arrays/text-arrays.test.ts#carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds:-:6"
				),
				reason: "nodejs/node#65994 on Node v26.13.0: U+0400 x 950 then 'a'",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/pg/write/text-arrays/text-arrays.test.ts#carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds:-:7"
				),
				reason: "nodejs/node#65994 on Node v26.13.0: 'a' x 52 then U+0400",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/pg/write/text-arrays/text-arrays.test.ts#carriesEveryTextAWritesSlotsOrAReadsRelationParameterHoldToPostgreSQLAsTheTextTheHostHolds:-:8"
				),
				reason: "nodejs/node#65994 on Node v26.13.0: 'a' x 309 then U+0400",
				since: "2026-11-09"
			}
		],
		kills: []
	})
