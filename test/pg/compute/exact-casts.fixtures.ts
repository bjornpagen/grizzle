/** What exact-casts.test.ts reads: its relation of texts and numerics cast into exact integers, and its space. */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Text, Type } from "#compiler/public/compute.ts"
import { exactInteger, generated, int4, numeric } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/** qti-pie's integer text (its ledger's walks.ts integerText at 7ea6419c), xs:integer's numeral. */
const integerText = Text.pattern("^[+-]?[0-9]+$")

/** The text's byte bound: a stored attribute's text, long enough for integers past bigint's. */
export const textBytes = 40

/**
 * A text and a numeric(30, 0) per id, and two exact integers PostgreSQL generates from them: the text's integer, parsed
 * in one step under qti-pie's integer guard (0 where the text is none), and the numeric widened.
 */
export const Digits = relation.generated(
	"Digits",
	{ id: int4, t: str.bytes(textBytes, str.regex("^.*$", "su")), n: numeric(30, 0) },
	["id"],
	(r) => ({
		parsed: generated(
			exactInteger,
			Logic.when(Text.matches(r.t, integerText), (d) => Type.cast(d, exactInteger), 0n)
		),
		widened: generated(exactInteger, Type.cast(r.n, exactInteger))
	})
)

export const ExactCasts = schema("ExactCasts", [Digits], [])

const programs = Object.freeze({
	insert: ChangeSet.empty(ExactCasts).insert(Digits, []),
	all: query(ExactCasts).rule((r) => {
		const { id, t, n, parsed, widened } = v(Digits, "d")
		return r.match(Digits, { id, t, n, parsed, widened }).find({ id, t, n, parsed, widened })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const exactCastsInstall = Object.freeze({ label: "exact_casts", programs })

/** ExactCasts installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const exactCastsTemplate = fixtureTemplate(import.meta, ExactCasts, exactCastsInstall)

/** What a case reaches: each kind of text, and a numeric past bigint's range. */
export type Feature =
	| "an integer text past bigint's range"
	| "an integer text of a sign and leading zeros"
	| "an integer text at the byte bound"
	| "a text of no integer"
	| "a numeric past bigint's range"

/** The digits of a numeral of `length` digits: a drawn head of at most three, padded with zeros. */
const numeral =
	(length: number): Gen<string> =>
	(source) => {
		const head = Str.slice(0, length)(String(source.draw(int(1, 999))))
		return `${head}${Str.repeat(length - head.length)("0")}`
	}

/** A text: an integer of a sign, leading zeros and a drawn length, up to the byte bound, or a text of none. */
const textGen: Gen<string> = weighted([
	[
		4,
		(source) => {
			const sign = source.draw(element(["", "+", "-"]))
			const zeros = Str.repeat(source.draw(int(0, 2)))("0")
			const length = source.draw(
				element([1, 3, 18, 19, 25, textBytes - sign.length - zeros.length])
			)
			return `${sign}${zeros}${source.draw(numeral(Math.max(length, 1)))}`
		}
	],
	[1, element(["1.5", "", "-", "+", "1e3", " 7", "7 ", "0x1", "１"])]
])

/** A numeric(30, 0): an integer of at most 30 digits, of either sign. */
const numericGen: Gen<bigint> = (source) => {
	const digits = source.draw(element([1, 5, 18, 19, 30]))
	const magnitude = BigInt(source.draw(numeral(digits)))
	return source.draw(element([false, true])) ? -magnitude : magnitude
}

/** A row of the case, by its place. */
export interface DrawnRow {
	readonly t: string
	readonly n: bigint
}

export const rowsGen: Gen<ReadonlyArray<DrawnRow>> = array(
	(source) => ({ t: source.draw(textGen), n: source.draw(numericGen) }),
	{ min: 1, max: 12 }
)

/** xs:integer's numeral, `[+-]?[0-9]+`, as the oracle reads a text, and a numeral of a sign and a leading zero. */
const integerNumeral = regex("^[+-]?[0-9]+$", "u")
const signedZero = regex("^[+-]0", "u")

/** The integer a text names by xs:integer's mapping, BigInt's over its numeral; 0 for a text of none. */
export const parsedOf = (t: string): bigint => (integerNumeral.test(t) ? BigInt(t) : 0n)

/** Whether an integer is past bigint's range. */
const pastBigint = (x: bigint): boolean => x > 9223372036854775807n || x < -9223372036854775808n

/** The features a row reaches. */
export const featuresOf = (row: DrawnRow): ReadonlyArray<Feature> => {
	const integer = integerNumeral.test(row.t)
	const text: ReadonlyArray<Feature> = integer
		? [
				...(pastBigint(BigInt(row.t)) ? ["an integer text past bigint's range" as const] : []),
				...(signedZero.test(row.t) ? ["an integer text of a sign and leading zeros" as const] : []),
				...(row.t.length === textBytes ? ["an integer text at the byte bound" as const] : [])
			]
		: ["a text of no integer"]
	return [...text, ...(pastBigint(row.n) ? ["a numeric past bigint's range" as const] : [])]
}
