import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Order, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { textArrayParam } from "#compiler/codec/recordset.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A text column's array parameter, which travels as a binary text[] of its values' UTF-8 bytes (codec/bytea.ts
 * textArray), on PostgreSQL 19rc2: every text a write's insert, put and delete slots carry, and every text a read's
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
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/text-arrays-last-byte-dropped.patch, each text[] element short of its
 * last byte, must turn the property red.
 */
const Body = str.regex("^.*$", "su")
const Note = relation("Note", { id: uuid, body: Body }, ["id"])
const Response = relation("Response", { id: uuid, value: Body }, ["id"])
const Texts = schema("TextArrays", { Note, Response }, [mutable(Note), mutable(Response)])

/**
 * The full world's workload: Note's insert, put and delete, each from its call's facts; Response's insert from the
 * relation parameter `responses`; and the reads of every Note, of the relation parameter `rows`, and of every Response.
 */
const programs = Object.freeze({
	insertNote: ChangeSet.empty(Texts).insert(Note, []),
	putNote: ChangeSet.empty(Texts).put(Note, []),
	deleteNote: ChangeSet.empty(Texts).delete(Note, []),
	answer: ChangeSet.empty(Texts).insert(
		Response,
		query(Texts).rule((r) => {
			const given = r.relation("responses", { id: Response.fields.id, value: Body })
			const row = v(given, "given")
			return r.match(given, row).find(row)
		})
	),
	notes: query(Texts).rule((r) => {
		const { id, body } = v(Note, "note")
		return r.match(Note, { id, body }).find({ id, body })
	}),
	echoed: query(Texts).rule((r) => {
		const rows = r.relation("rows", { body: Body })
		const row = v(rows, "row")
		return r.match(rows, row).find(row)
	}),
	recorded: query(Texts).rule((r) => {
		const { id, value } = v(Response, "response")
		return r.match(Response, { id, value }).find({ id, value })
	})
})

/** One scalar of a text: a character a literal array quotes or escapes, or a scalar of any plane but NUL. */
const scalar: Gen<string> = weighted([
	[
		3,
		element([
			'"',
			"\\",
			"{",
			"}",
			",",
			" ",
			"\t",
			"\n",
			"'",
			"a",
			"é",
			"Ѐ",
			"ש",
			"ك",
			"漢",
			"\u{1F600}",
			"\u{10FFFF}"
		])
	],
	[1, oneOf([codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ff_ff)])]
])

/** A scalar whose presence let the encodeInto of nodejs/node#65994 underfill: U+0400 to U+07FF. */
const twoByteRange: Gen<string> = codePoint(0x04_00, 0x07_ff)

/**
 * A text: the empty text, the text NULL in a case, a short run of scalars, a run of 53 to 1200 scalars, a run of one
 * scalar ending in a scalar of U+0400 to U+07FF and a tail of up to three scalars, a run of ASCII with one scalar of
 * U+0400 to U+07FF anywhere in it, or a long run of one scalar. The underfill's lengths are not contiguous, so every
 * length of the band is drawn.
 */
const text: Gen<string> = weighted([
	[1, constant("")],
	[1, element(["NULL", "null", "Null"])],
	[4, map(array(scalar, { min: 1, max: 8 }), Arr.join(""))],
	[2, map(array(scalar, { min: 53, max: 1200 }), Arr.join(""))],
	[
		2,
		(s) => {
			const run = Str.repeat(s.draw(int(0, 1200)))(s.draw(scalar))
			const tail = Arr.join(s.draw(array(scalar, { min: 0, max: 3 })), "")
			return `${run}${s.draw(twoByteRange)}${tail}`
		}
	],
	[
		1,
		(s) => {
			const length = s.draw(int(53, 1200))
			const at = s.draw(int(0, length - 1))
			return `${Str.repeat(at)("a")}${s.draw(twoByteRange)}${Str.repeat(length - 1 - at)("a")}`
		}
	],
	[1, map(scalar, (s) => Str.repeat(2 ** 12)(s))]
])

/** A child's Cyrillic answer of 281 units ending in U+0400. */
const cyrillicAnswer = `${Str.repeat(14)("Ученик выбрал ответ ")}Ѐ`

/** A child's Hebrew answer of 271 units ending in a Hebrew letter. */
const hebrewAnswer = `${Str.repeat(15)("התלמיד בחר בתשובה ")}ש`

/** The texts of the lengths where nodejs/node#65994 underfilled on Node v26.13.0, beside the two answers. */
const underfilled: ReadonlyArray<readonly [string, string]> = [
	["U+0400 x 258 then 'a'", `${Str.repeat(258)("Ѐ")}a`],
	["U+0400 x 263 then 'a'", `${Str.repeat(263)("Ѐ")}a`],
	["U+0400 x 317 then 'a'", `${Str.repeat(317)("Ѐ")}a`],
	["U+0400 x 950 then 'a'", `${Str.repeat(950)("Ѐ")}a`],
	["'a' x 52 then U+0400", `${Str.repeat(52)("a")}Ѐ`],
	["'a' x 309 then U+0400", `${Str.repeat(309)("a")}Ѐ`]
]

type TextFeature =
	| "a quote or a backslash"
	| "a brace or a comma"
	| "the text NULL"
	| "an astral scalar"
	| "the empty text"
	| "a long text"
	| "a text of 53 units or more holding U+0400 to U+07FF"

const features: Arr.NonEmptyReadonlyArray<TextFeature> = [
	"a quote or a backslash",
	"a brace or a comma",
	"the text NULL",
	"an astral scalar",
	"the empty text",
	"a long text",
	"a text of 53 units or more holding U+0400 to U+07FF"
]

/** Whether a text holds a scalar of U+0400 to U+07FF. */
const holdsTwoByteRange = (t: string): boolean =>
	Arr.some(Arr.fromIterable(t), (point) =>
		Option.exists(Str.codePointAt(0)(point), (code) => code >= 0x04_00 && code <= 0x07_ff)
	)

/** A text's code points reversed, so a put changes every text but a palindrome's. */
const reversed = (t: string): string => Arr.join(Arr.reverse(Array.from(t)), "")

/** Texts in code unit order, so two reads compare as multisets. */
const sorted = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(texts, Order.String)

layer(Substrate.layer, { excludeTestServices: true })("a text column's array parameter", (it) => {
	it.effect(
		"carries every text a write's slots or a read's relation parameter hold to PostgreSQL as the text the host holds",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(Texts, {}, { label: "textarrays", extensions: [], programs })
					const s = yield* Substrate
					const names = namesOf(o.installed)
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(o.served.login.roles.app, {})
						const bodies = Effect.map(
							Effect.flatMap(db.workload.notes.execute({}), (r) => r.collect),
							(rows) => sorted(Arr.map(rows, (row) => row.body))
						)
						const values = Effect.map(
							Effect.flatMap(db.workload.recorded.execute({}), (r) => r.collect),
							(rows) => sorted(Arr.map(rows, (row) => row.value))
						)
						return yield* explore(
							{
								suite: "pg/write/text-arrays",
								draw: drawn(array(text, { min: 1, max: 6 })),
								literal: Formatter.format,
								oracle: {
									kind: "second-implementation",
									name: "the texts PostgreSQL stores from the text array literal of the texts written"
								},
								coverage: required<TextFeature>(features, { cases: 40, sense: notesOnly }),
								kept: [
									{
										note: "a child's Cyrillic answer of 281 units ending in U+0400, which encodeInto wrote two bytes short",
										sketch: [cyrillicAnswer],
										draws: "",
										reaches: ["a text of 53 units or more holding U+0400 to U+07FF"]
									},
									{
										note: "a child's Hebrew answer of 271 units ending in a Hebrew letter, which encodeInto wrote two bytes short",
										sketch: [hebrewAnswer],
										draws: "",
										reaches: ["a text of 53 units or more holding U+0400 to U+07FF"]
									},
									...Arr.map(underfilled, ([note, t]) => ({
										note: `nodejs/node#65994 on Node v26.13.0: ${note}`,
										sketch: [t],
										draws: "",
										reaches: Arr.of<TextFeature>(
											"a text of 53 units or more holding U+0400 to U+07FF"
										)
									}))
								],
								runs: 40,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 8,
								caseHang
							},
							(texts, c) =>
								Effect.gen(function* () {
									yield* replaceRows(s.admin, installationGroup(names), [])
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
									const inserted = yield* db.workload.insertNote.apply(
										{ insert: { Note: rows } },
										{}
									)
									assert.equal(inserted.kind, "accepted", "the insert is accepted")
									const afterInsert = yield* bodies
									const insertedLiteral = yield* literal(texts)
									assert.deepEqual(afterInsert, insertedLiteral, "the inserted texts read back")
									const put = Arr.map(rows, (row) => ({ id: row.id, body: reversed(row.body) }))
									const putOutcome = yield* db.workload.putNote.apply({ put: { Note: put } }, {})
									assert.ok(
										putOutcome.kind === "accepted" || putOutcome.kind === "no-change",
										`the put is lawful, not ${putOutcome.kind}`
									)
									const afterPut = yield* bodies
									const putLiteral = yield* literal(Arr.map(put, (row) => row.body))
									assert.deepEqual(afterPut, putLiteral, "the put texts read back")
									const deleted = Arr.filter(put, (_, i) => i % 2 === 1)
									const kept = Arr.filter(put, (_, i) => i % 2 === 0)
									const deletedOutcome = yield* db.workload.deleteNote.apply(
										{ delete: { Note: deleted } },
										{}
									)
									assert.ok(
										deletedOutcome.kind === "accepted" || deletedOutcome.kind === "no-change",
										`the delete is lawful, not ${deletedOutcome.kind}`
									)
									const afterDelete = yield* bodies
									const keptLiteral = yield* literal(Arr.map(kept, (row) => row.body))
									assert.deepEqual(
										afterDelete,
										keptLiteral,
										"the delete removes exactly the facts it names"
									)
									const echoRows = Arr.map(texts, (body) => ({ body }))
									const echoes = yield* Effect.flatMap(
										db.workload.echoed.execute({ rows: echoRows }),
										(r) => r.collect
									)
									const echoedLiteral = yield* literal(Arr.dedupe(texts))
									assert.deepEqual(
										sorted(Arr.map(echoes, (row) => row.body)),
										echoedLiteral,
										"a relation parameter's texts read back"
									)
									const responses = Arr.map(texts, (value, i) => ({ id: uuidOf(i + 1), value }))
									const answeredOutcome = yield* db.workload.answer.apply({ responses })
									assert.equal(
										answeredOutcome.kind,
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
								})
						)
					}).pipe(
						(body) =>
							Effect.flatMap(Layer.build(o.served.layer), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				}).pipe(Effect.scoped)
			)
	)
})
