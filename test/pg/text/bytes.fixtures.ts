/** What the properties of bytes.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case as SearchCase } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { textInfoBounds, textOf } from "#compiler/ir/scalar.ts"
import { int4 } from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ProgramPatterns } from "#compiler/scalar/regex/patterns.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { jsMatcher } from "#test/support/regex.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A case's pattern: every text, at most so many code points, or letters of every width of no bound. */
type Pattern =
	| { readonly kind: "every" }
	| { readonly kind: "upTo"; readonly codePoints: number }
	| { readonly kind: "letters" }

/** A UTF-8 width, the bytes of one code point of a script. */
type Width = 1 | 2 | 3 | 4

interface BytesCase {
	readonly bytes: number
	readonly pattern: Pattern
	readonly width: Width
}

/** A code point of each width: ASCII, Latin-1, the euro sign and a Gothic letter beyond the BMP. */
const scriptOf: Readonly<Record<Width, string>> = { 1: "a", 2: "é", 3: "€", 4: "𐍈" }

const widths: Arr.NonEmptyReadonlyArray<Width> = [1, 2, 3, 4]

const sourceOf = (p: Pattern): { readonly source: string; readonly flags: "u" | "su" } => {
	switch (p.kind) {
		case "every":
			return { source: "^.*$", flags: "su" }
		case "upTo":
			return { source: `^.{0,${p.codePoints}}$`, flags: "su" }
		case "letters":
			return { source: "^[a-zé€𐍈]*$", flags: "u" }
	}
}

/** The most code points and UTF-8 bytes a pattern's language holds, none for a pattern of no bound. */
const patternBounds = (
	p: Pattern
): { readonly length: number; readonly bytes: number } | undefined =>
	p.kind === "upTo" ? { length: p.codePoints, bytes: 4 * p.codePoints } : undefined

const patternGen: Gen<Pattern> = weighted<Pattern>([
	[1, element<Pattern>([{ kind: "every" }, { kind: "letters" }])],
	[2, (source) => ({ kind: "upTo", codePoints: source.draw(int(0, 120)) })]
])

export const caseGen: Gen<BytesCase> = (source) => ({
	bytes: source.draw(int(0, 400)),
	pattern: source.draw(patternGen),
	width: source.draw(element(widths))
})

const utf8 = new TextEncoder()

const utf8Bytes = (text: string): number => utf8.encode(text).length

/** A text of exactly `bytes` UTF-8 bytes in the script of `width`: its code points, then ASCII for the rest. */
const textOfBytes = (bytes: number, width: Width): string => {
	const whole = Math.floor(bytes / width)
	return Str.repeat(whole)(scriptOf[width]) + Str.repeat(bytes - whole * width)("a")
}

/** A case's values: of N - 1, N and N + 1 bytes, none below zero. */
const valuesOf = (c: BytesCase): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter([c.bytes - 1, c.bytes, c.bytes + 1], (b) => b >= 0),
		(b) => textOfBytes(b, c.width)
	)

/** Whether a value is a member of the case's language: its pattern's, by ECMAScript, within its bytes. */
const memberOf = (c: BytesCase): ((value: string) => boolean) => {
	const { source, flags } = sourceOf(c.pattern)
	const ofPattern = jsMatcher(source, flags)
	return (value) => utf8Bytes(value) <= c.bytes && ofPattern(value)
}

export type BytesFeature =
	| `${Width}-byte script`
	| "every text"
	| "a pattern of no bound"
	| "a bound the pattern meets"
	| "a bound that cuts the pattern"
	| "N - 1 stored"
	| "N stored"
	| "N + 1 refused"
	| "refused by the pattern"

export const requiredFeatures: Arr.NonEmptyReadonlyArray<BytesFeature> = [
	"1-byte script",
	"2-byte script",
	"3-byte script",
	"4-byte script",
	"every text",
	"a pattern of no bound",
	"a bound the pattern meets",
	"a bound that cuts the pattern",
	"N - 1 stored",
	"N stored",
	"N + 1 refused",
	"refused by the pattern"
]

/** The field of a case: str.bytes over its pattern. */
const fieldOf = (c: BytesCase): FieldBase => {
	const { source, flags } = sourceOf(c.pattern)
	return str.bytes(c.bytes, regexField(source, [flags]))
}

/** The situations a case's pattern and bound reach. */
const patternFeatures = (c: BytesCase): ReadonlyArray<BytesFeature> => {
	const bounds = patternBounds(c.pattern)
	const kind: ReadonlyArray<BytesFeature> =
		c.pattern.kind === "every"
			? ["every text"]
			: c.pattern.kind === "letters"
				? ["a pattern of no bound"]
				: []
	return [
		`${c.width}-byte script`,
		...kind,
		bounds !== undefined && bounds.bytes <= c.bytes
			? "a bound the pattern meets"
			: "a bound that cuts the pattern"
	]
}

/** The name of the relation of the case at a position. */
const relationName = (at: number): string => `R${at}`

/** Cases per batch, each its own relation of the batch's one schema. */
export const cases = 24

/** Installs a batch's fields as one schema, checks each field's analysis, and inserts each value as a direct writer. */
export const checkBatch = (
	batch: ReadonlyArray<BytesCase>,
	note: SearchCase<BytesFeature>["noteAll"]
) =>
	Effect.gen(function* () {
		const fields = Arr.map(batch, fieldOf)
		const relations = Arr.map(fields, (t, i) =>
			relationBuilder(relationName(i), { id: int4, t }, ["id"], [])
		)
		const installed = yield* install(
			schema(
				"Bytes",
				Rec.values(Rec.fromEntries(Arr.map(relations, (r, i) => [relationName(i), r]))),
				[]
			),
			{ ambient: ordinarySession, label: "bytes", extensions: [] }
		)
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "bytes writer" })
		for (const [i, c] of batch.entries()) {
			note(patternFeatures(c))
			const where = `R${i}, ${Formatter.format(c)}`
			const field = defined(fields[i], "the case's field")
			const text = defined(
				textOf(succeeded(describeField(field, SourceLoc("field", []))).scalar),
				"a text field's refinement"
			)
			const bounds = patternBounds(c.pattern)
			assert.equal(
				textInfoBounds(text)?.bytes,
				Math.min(bounds === undefined ? c.bytes : bounds.bytes, c.bytes),
				`${where}: its bytes bounded at the lesser of the pattern's and N`
			)
			assert.equal(
				textInfoBounds(text)?.length,
				Math.min(bounds === undefined ? c.bytes : bounds.length, c.bytes),
				`${where}: its code points bounded at the lesser of the pattern's and N`
			)
			const name = installed.names.relation(`R${i}`)
			const table = `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
			const columns = Arr.join(
				Arr.map(["id", "t"], (f) => quoteIdent(installed.names.column(`R${i}`, f))),
				", "
			)
			const member = memberOf(c)
			for (const [j, value] of valuesOf(c).entries()) {
				const lawful = member(value)
				const bytes = utf8Bytes(value)
				const at = `${where}, a value of ${bytes} bytes`
				const regex = text
				assert.equal(
					typeof regex === "string" || ProgramPatterns.of(regex.patterns).member(regex, value),
					lawful,
					`${at}: the host's membership`
				)
				const inserted = yield* Effect.result(
					session.query(`INSERT INTO ${table} (${columns}) VALUES ($1, $2)`, [j, value])
				)
				assert.equal(
					inserted._tag,
					lawful ? "Success" : "Failure",
					`${at} is ${lawful ? "stored" : "refused"}`
				)
				const fault = inserted._tag === "Failure" ? pgErrorFields(inserted.failure) : undefined
				assert.equal(fault?.code, lawful ? undefined : "23514", at)
				if (lawful && bytes === c.bytes - 1) {
					note(["N - 1 stored"])
				}
				if (lawful && bytes === c.bytes) {
					note(["N stored"])
				}
				if (!lawful && bytes === c.bytes + 1) {
					note(["N + 1 refused"])
				}
				if (!lawful && bytes <= c.bytes) {
					note(["refused by the pattern"])
				}
			}
		}
	})
