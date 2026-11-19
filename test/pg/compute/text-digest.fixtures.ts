/** What the property of text-digest.test.ts reads: its schema and template, its space, and each case's run. */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Data, Effect, Formatter, Option, Result, String as Str } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { check, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"

/**
 * A text and its digest: Note's `body`, any text, and `digest`, PostgreSQL's SHA-256 of its UTF-8 as lowercase hex
 * (Compute.sha256 over text), a STORED generated column, beside a row check that holds the digest to the body's, which
 * the check and the generated field lower through the installation's textDigest library function alike.
 */
const Body = str.regex("^.*$", "su")
const Digest = str.regex("^[0-9a-f]{64}$")

const Note = relation.generated("Note", { id: pg.integer, body: Body }, ["id"], (n) => ({
	digest: generated(Digest, Compute.sha256(n.body))
}))

const digestSchema = schema(
	"text_digest",
	[Note],
	[check("Digested", Note, (n) => n.eq(n.digest, Compute.sha256(n.body)))]
)

export const digestTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "text digest",
	content: { schema: digestSchema.name, logins: [] },
	versions: [{ schema: digestSchema, logins: [], declarations: noDeclarations }],
	options: {
		label: "text_digest",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The host's evaluator of the schema, compiled once. */
const evaluate = succeeded(rowEvaluator(digestSchema), "the digest schema compiles")

/**
 * The characters a text is drawn of, by their UTF-8 width: ASCII (a quote and a backslash among them, which a text's
 * literal escapes and a cast to bytea reads as an escape), two-byte, three-byte and four-byte (a surrogate pair in
 * UTF-16), and the whitespace a collapse would read.
 */
const characters = [
	"a",
	"Z",
	"0",
	"'",
	"\\",
	"\t",
	"\n",
	" ",
	"é",
	"ß",
	"中",
	"€",
	"😀",
	"𝄞"
] as const

/** A text of one class of length: empty, short, or past a SHA-256 block of 64 bytes many times over. */
const textGen: Gen<string> = (s) =>
	s.draw(
		weighted([
			[1, () => ""],
			[6, (t) => Arr.join(t.draw(array(element(characters), { min: 1, max: 12 })), "")],
			[
				2,
				(t) => {
					const unit = Arr.join(t.draw(array(element(characters), { min: 1, max: 4 })), "")
					return Str.repeat(t.draw(int(16, 600)))(unit)
				}
			]
		])
	)

/** A case: the texts one transaction inserts, each a row of Note. */
export interface Written {
	readonly texts: Arr.NonEmptyReadonlyArray<string>
}

export const writtenGen: Gen<Written> = (s) => {
	const first = s.draw(textGen)
	const more = s.draw(array(textGen, { min: 0, max: 5 }))
	return { texts: [first, ...more] }
}

export type DigestFeature =
	| "the empty text"
	| "a multibyte character"
	| "a character past the BMP"
	| "a quote or a backslash"
	| "a text past a SHA-256 block"

/** A digest that is not SHA-256's of the text's UTF-8, naming the case. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The oracle: SHA-256 (FIPS 180-4) of the text's UTF-8 (RFC 3629) bytes, as lowercase hex, by Web Crypto. */
const oracleDigest = (text: string) =>
	Effect.map(
		Effect.promise(() =>
			globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
		),
		(digest) =>
			Arr.join(
				Arr.map([...new Uint8Array(digest)], (b) => Str.padStart(2, "0")(b.toString(16))),
				""
			)
	)

/** A character past ASCII. */
const multibyte = regex("[^\\u0000-\\u007f]", "u")

/** A character past the BMP, which UTF-16 writes as a surrogate pair. */
const astral = regex("[\\u{10000}-\\u{10ffff}]", "u")

/**
 * One case in its one transaction, which the case's end rolls back: each text inserted as a row of Note by a direct
 * writer, its body bound as a parameter, so no literal escapes it, and the row check judged at once. Every insert is
 * accepted, its check holding; each row's stored digest, PostgreSQL's generated column, is the oracle's digest of its
 * body; and so is the host evaluator's value of the generated field over the row as it admits it.
 */
export const runDigests = (
	installed: Installed,
	connection: PgConnection,
	written: Written,
	c: Case<DigestFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const table = names.table(Note)
		const id = names.column(Note, "id")
		const body = names.column(Note, "body")
		const digest = names.column(Note, "digest")
		for (const [i, text] of written.texts.entries()) {
			const refused = yield* refusalOf(
				connection.query(`INSERT INTO ${table} (${id}, ${body}) VALUES ($1, $2)`, [String(i), text])
			)
			if (Option.isSome(refused)) {
				return yield* new Disagreed({
					message: `the insert of ${Formatter.format(text)} was refused under ${refused.value.code}, where its digest holds of its body`
				})
			}
		}
		const stored = yield* connection.queryValues(
			`SELECT ${id}::text, ${digest} FROM ${table} ORDER BY ${id}`,
			[]
		)
		for (const [i, text] of written.texts.entries()) {
			const expected = yield* oracleDigest(text)
			const row = stored[i]
			if (row?.[1] !== expected) {
				return yield* new Disagreed({
					message: `PostgreSQL's digest of ${Formatter.format(text)} is ${Formatter.format(row?.[1])}, SHA-256 of its UTF-8 ${expected}`
				})
			}
			const host = Result.flatMap(
				evaluate.admit(Note, { id: i, body: text }),
				(admitted) => evaluate(Note, admitted).generated.digest
			)
			if (!Result.isSuccess(host) || host.success !== expected) {
				return yield* new Disagreed({
					message: `the host's digest of ${Formatter.format(text)} is ${Formatter.format(host)}, SHA-256 of its UTF-8 ${expected}`
				})
			}
		}
		const texts = written.texts
		if (Arr.some(texts, (t) => t === "")) {
			c.note("the empty text")
		}
		if (Arr.some(texts, (t) => multibyte.test(t))) {
			c.note("a multibyte character")
		}
		if (Arr.some(texts, (t) => astral.test(t))) {
			c.note("a character past the BMP")
		}
		if (Arr.some(texts, (t) => Str.includes("'")(t) || Str.includes("\\")(t))) {
			c.note("a quote or a backslash")
		}
		if (Arr.some(texts, (t) => Buffer.byteLength(t, "utf8") > 64)) {
			c.note("a text past a SHA-256 block")
		}
	})
