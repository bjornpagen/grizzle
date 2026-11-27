/** What the properties of long-texts.test.ts read: its schema, its space and its helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, pipe, String as Str } from "effect"
import { drawn, natural } from "#compiler/public/fields.ts"
import { fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id, type IdValue, toId } from "#test/support/ids.ts"
import { longFamily } from "#test/support/kernel/long-keys.ts"

/** A text of lowercase letters and digits, of any length: what a title and a line's body hold. */
const prose = str.regex("^[a-z0-9]*$")

/** Doc(id, title, lines drawn): the owner of the ordered family of Line. */
const Doc = relation("Doc", { id: Id, title: prose, lines: drawn(natural) }, ["id"])

/** Line(doc, at drawn, body): a doc's line at its place. */
const Line = relation("Line", { doc: Id, at: drawn(natural), body: prose }, ["doc", "at"])

/** The schema a case writes: docs, each nesting its lines in order. */
export const LongTexts = schema(
	"LongTexts",
	[Doc, Line],
	[ordered(on(Line, "doc", "at"), fin(Doc, "lines"))]
)

/** A case: its docs, each a title and its lines, every text one of `family` by its index. */
export interface LongTextsCase {
	readonly family: ReadonlyArray<string>
	readonly docs: Arr.NonEmptyReadonlyArray<{
		readonly title: number
		readonly lines: ReadonlyArray<number>
	}>
}

/** The cases: a family of one to four long texts, and one to three docs, each titled by one and holding up to three lines of them. */
export const longTextsCase: Gen<LongTextsCase> = (source) => {
	const family = longFamily(source.draw(int(1, 4)))
	const text = int(0, family.length - 1)
	const docs = source.draw(
		array((s) => ({ title: s.draw(text), lines: s.draw(array(text, { min: 0, max: 3 })) }), {
			min: 1,
			max: 3
		})
	)
	const [first, ...rest] = docs
	if (first === undefined) {
		throw new RangeError("a case draws at least one doc")
	}
	return { family, docs: [first, ...rest] }
}

/** The doc numbered `n`'s id. */
const docId = (n: number): IdValue =>
	toId(`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`)

/** A case's facts as insertAll takes them: each doc, its title and its lines' bodies, in order. */
export const factsOf = (c: LongTextsCase) => ({
	Doc: Arr.map(c.docs, (doc, n) => ({
		id: docId(n),
		title: defined(c.family[doc.title], "a title of the family"),
		lines: Arr.map(doc.lines, (line) => ({ body: defined(c.family[line], "a body of the family") }))
	}))
})
