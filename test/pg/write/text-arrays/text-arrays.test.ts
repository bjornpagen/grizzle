import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Order, String as Str } from "effect"
import { compiledOpen } from "#adapter/db/open.ts"
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
import { loginLayer } from "#test/support/worlds.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A text column's array parameter, which travels as a binary text[] of its values' UTF-8 bytes (codec/bytea.ts
 * textArray), on PostgreSQL 19rc1: every text a write's insert, put and delete slots carry, and every text a read's
 * relation parameter carries, reaches PostgreSQL as the very text the host holds, as the literal array it replaced
 * delivered it.
 *
 * The schema is one mutable relation of a key and a text of any characters. A case is a list of texts, each drawn from
 * the characters a literal array quotes or escapes (quotes, backslashes, braces, commas, white space, the text NULL),
 * every plane's scalars (multibyte and astral), the empty text and long texts. It inserts one row per text, reads them
 * back, puts each row's text reversed, reads them back, deletes the rows at even keys by their facts, reads the rest
 * back, and reads the texts back through a relation parameter.
 *
 * The oracle is the literal path the binary array replaced (codec/recordset.ts textArrayParam): each read gives exactly
 * the texts PostgreSQL stores from the text array literal of the texts written, compared as JavaScript strings.
 */
const Body = str.regex("^.*$", "su")
const Note = relation("Note", { id: uuid, body: Body }, ["id"])
const Texts = schema("TextArrays", { Note }, [mutable(Note)])

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
			"漢",
			"\u{1F600}",
			"\u{10FFFF}"
		])
	],
	[1, oneOf([codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ff_ff)])]
])

/** A text: the empty text, the text NULL in a case, a run of scalars, or a long run of one scalar. */
const text: Gen<string> = weighted([
	[1, constant("")],
	[1, element(["NULL", "null", "Null"])],
	[6, map(array(scalar, { min: 1, max: 8 }), Arr.join(""))],
	[1, map(scalar, (s) => Str.repeat(2 ** 12)(s))]
])

type TextFeature =
	| "a quote or a backslash"
	| "a brace or a comma"
	| "the text NULL"
	| "an astral scalar"
	| "the empty text"
	| "a long text"

const features: Arr.NonEmptyReadonlyArray<TextFeature> = [
	"a quote or a backslash",
	"a brace or a comma",
	"the text NULL",
	"an astral scalar",
	"the empty text",
	"a long text"
]

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
					const o = yield* installed(
						Texts,
						{},
						{ label: "textarrays", extensions: [], programs: {} }
					)
					const s = yield* Substrate
					const names = namesOf(o.installed)
					return yield* Effect.gen(function* () {
						const db = yield* compiledOpen(o.server.roles.app, {})
						const empty = ChangeSet.empty(o.schema)
						const notes = query(o.schema).rule((r) => {
							const { id, body } = v(Note, "note")
							return r.match(Note, { id, body }).find({ id, body })
						})
						const echoed = query(o.schema).rule((r) => {
							const rows = r.relation("rows", { body: Body })
							const row = v(rows, "row")
							return r.match(rows, row).find(row)
						})
						const bodies = Effect.map(
							Effect.flatMap(db.execute(notes, {}), (r) => r.collect),
							(rows) => sorted(Arr.map(rows, (row) => row.body))
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
								kept: [],
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
									const inserted = yield* db.apply(empty.insert(Note, rows), {})
									assert.equal(inserted.kind, "accepted", "the insert is accepted")
									const afterInsert = yield* bodies
									const insertedLiteral = yield* literal(texts)
									assert.deepEqual(afterInsert, insertedLiteral, "the inserted texts read back")
									const put = Arr.map(rows, (row) => ({ id: row.id, body: reversed(row.body) }))
									const putOutcome = yield* db.apply(empty.put(Note, put), {})
									assert.ok(
										putOutcome.kind === "accepted" || putOutcome.kind === "no-change",
										`the put is lawful, not ${putOutcome.kind}`
									)
									const afterPut = yield* bodies
									const putLiteral = yield* literal(Arr.map(put, (row) => row.body))
									assert.deepEqual(afterPut, putLiteral, "the put texts read back")
									const deleted = Arr.filter(put, (_, i) => i % 2 === 1)
									const kept = Arr.filter(put, (_, i) => i % 2 === 0)
									const deletedOutcome = yield* db.apply(empty.delete(Note, deleted), {})
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
									const echoes = yield* Effect.flatMap(
										db.execute(echoed, { rows: Arr.map(texts, (body) => ({ body })) }),
										(r) => r.collect
									)
									const echoedLiteral = yield* literal(Arr.dedupe(texts))
									assert.deepEqual(
										sorted(Arr.map(echoes, (row) => row.body)),
										echoedLiteral,
										"a relation parameter's texts read back"
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
								})
						)
					}).pipe(
						(body) =>
							Effect.flatMap(Layer.build(loginLayer(o.installed, o.server)), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				}).pipe(Effect.scoped)
			)
	)
})
