/** What the properties of bytes-guard.test.ts read: its spaces, models and helpers. */

import { codePoints } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { Id } from "#test/support/ids.ts"
import { stringsOver } from "#test/support/unit/text/generators.ts"

/** The guard over the cast: the text's bytes within [low, high], or none. */
type Guard =
	| { readonly kind: "within"; readonly low: number; readonly high: number }
	| { readonly kind: "none" }

/** The text's own type: any text, a pattern of at most so many code points, or a byte bound of its own. */
type Source =
	| { readonly kind: "every" }
	| { readonly kind: "upTo"; readonly codePoints: number }
	| { readonly kind: "bytes"; readonly bytes: number }

interface Case {
	readonly source: Source
	readonly guard: Guard
	readonly target: number
	readonly texts: ReadonlyArray<string>
}

export type Feature =
	| "a cast under no guard"
	| "refused, naming the bound"
	| "admitted by the guard's bound"
	| "admitted by the text's own bound"
	| "a text the guard holds, stored"
	| "a text the guard keeps out, stored as the other value"

/** One, two, three and four UTF-8 bytes a code point: ASCII, Latin-1, the euro sign and an emoji. */
const alphabet: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x7a, 0xe9, 0x20ac, 0x1f600]

const sourceGen: Gen<Source> = weighted<Source>([
	[2, () => ({ kind: "every" })],
	[1, (source) => ({ kind: "upTo", codePoints: source.draw(int(0, 12)) })],
	[1, (source) => ({ kind: "bytes", bytes: source.draw(int(0, 48)) })]
])

const guardGen: Gen<Guard> = weighted<Guard>([
	[
		4,
		(source) => {
			const high = source.draw(int(0, 40))
			return { kind: "within", low: source.draw(int(0, high)), high }
		}
	],
	[1, () => ({ kind: "none" })]
])

export const caseGen: Gen<Case> = (source) => ({
	source: source.draw(sourceGen),
	guard: source.draw(guardGen),
	target: source.draw(int(0, 40)),
	texts: source.draw(array(stringsOver(element(alphabet), 14), { min: 1, max: 12 }))
})

/** The bytes the text's own type bounds it to: four a code point for a pattern's, none for any text. */
export const sourceBytes = (s: Source): number => {
	switch (s.kind) {
		case "every":
			return Number.POSITIVE_INFINITY
		case "upTo":
			return 4 * s.codePoints
		case "bytes":
			return s.bytes
	}
}

/** Whether a text is a value of the text's own type. */
export const sourceHolds = (s: Source, text: string): boolean => {
	switch (s.kind) {
		case "every":
			return true
		case "upTo":
			return codePoints(text).length <= s.codePoints
		case "bytes":
			return utf8Length(text) <= s.bytes
	}
}

/** The byte counts a case's guard holds of: its interval, or every count where it has none. */
export const interval = (g: Guard): readonly [number, number] =>
	g.kind === "within" ? [g.low, g.high] : [0, Number.POSITIVE_INFINITY]

/** Whether compilation must admit the cast: the bytes the guard or the text's own type leaves it are at most n. */
export const admitted = (c: Case): boolean =>
	Math.min(sourceBytes(c.source), interval(c.guard)[1]) <= c.target

/** The text's own field. */
const sourceField = (s: Source) => {
	const every = str.regex("^.*$", "su")
	switch (s.kind) {
		case "every":
			return every
		case "upTo":
			return regexField(`^.{0,${s.codePoints}}$`, ["su"])
		case "bytes":
			return str.bytes(s.bytes, every)
	}
}

/**
 * A case's schema: Texts, whose generated field casts its text into n bytes, under the case's guard of the text's
 * bytes with "" elsewhere, or alone. The guard's branch receives the count and casts the text it counts.
 */
export const schemaOf = (c: Case) => {
	const Target = str.bytes(c.target, str.regex("^.*$", "su"))
	const Texts = relation.generated(
		"Texts",
		{ id: Id, n: pg.integer, text: sourceField(c.source) },
		["id"],
		(r) => ({
			stored: generatedField(
				Target,
				c.guard.kind === "within"
					? computeCore.when(
							computeCore.within(computeCore.octetLength(r.text), c.guard.low, c.guard.high),
							() => computeCore.cast(r.text, Target),
							""
						)
					: computeCore.cast(r.text, Target),
				[]
			)
		})
	)
	return { Texts, value: schema("BytesGuard", [Texts], []) }
}
