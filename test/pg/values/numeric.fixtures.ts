/** What the properties of numeric.test.ts read: its spaces, models and helpers. */

import { assert, contains, unorderedEqual } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, String as Str } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { Numeric, integerOfDecimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { decimalGen, numericText, orderOf } from "#test/support/unit/values/support.ts"

interface Case {
	readonly ord: number
	readonly v: string
	readonly p: number
	readonly s: number
}

const precision = weighted([
	[12, int(1, 40)],
	[1, element([1, 1000])]
])

const scale = weighted([
	[12, int(-12, 45)],
	[1, element([-1000, 0, 1000])]
])

/**
 * A literal one digit past p nines at scale s: it fits when the extra digit rounds down and overflows when it rounds up.
 */
const boundary: Gen<Omit<Case, "ord">> = (source) => {
	const p = source.draw(precision)
	const s = source.draw(scale)
	const sign = source.draw(element(["", "-"]))
	const extra = source.draw(element(["4", "5", "9", "49", "50"]))
	const nines = source.draw(int(Math.min(Math.max(1, p - 2), 60), Math.min(p, 60)))
	return { v: `${sign}${Str.repeat(nines)("9")}${extra}e${-s - extra.length}`, p, s }
}

const drawnCase = weighted<Omit<Case, "ord">>([
	[
		7,
		(source) => ({
			v: source.draw(numericText),
			p: source.draw(precision),
			s: source.draw(scale)
		})
	],
	[3, boundary],
	[1, (source) => ({ v: source.draw(element(["NaN", "Infinity", "-Infinity"])), p: 10, s: 2 })]
])

/** A batch of up to 2,500 cases, a case's one recordset, each numbered by its position. */
export const caseBatch: Gen<ReadonlyArray<Case>> = map(
	array(drawnCase, { min: 1, max: 2500 }),
	(batch) => Arr.map(batch, (c, ord) => ({ ord, ...c }))
)

/**
 * What a coercion case reached: an overflow the rounding alone causes, a negative scale, and a scale above the
 * precision.
 */
export type CoercionFeature = "overflow by rounding" | "negative scale" | "scale above precision"

/** The refusals of a value numeric(p, s) cannot hold, which PostgreSQL raises as 22003. */
const overflowFaults: ReadonlyArray<ValueFault> = ["numericOverflow", "numericInfinity"]

/**
 * The host's answer: the coerced numeric text, or the SQLSTATE PostgreSQL raises for the refusal (22003 for
 * numeric field overflow and for an infinity under a typmod).
 */
export const hostAnswer = (c: Case): string => {
	const normalized = normalizeNumeric(succeeded(Numeric.fromString(c.v)), {
		precision: c.p,
		scale: c.s
	})
	if (normalized.ok) {
		return normalized.value.toString()
	}
	contains(overflowFaults, normalized.error)
	return "22003"
}

/**
 * The numeric(p, s) codec's answer: the value its encoder writes for the literal, read back as its one text, or
 * "refused". The literal is given as the type's host value: a Numeric, but numeric(p, 0)'s bigint, an integer type's
 * (codec/scalar.ts carrierSpecOf, ir/carriers.ts isIntegerTypmod), whose caller holds no fraction, so a literal with one
 * is refused there before the encoder.
 */
export const codecAnswer = (c: Case): string => {
	const codec = scalarCodec(
		scalarOf({ kind: "numeric", precision: c.p, scale: c.s }, {}),
		emptyCodebook
	)
	const literal = succeeded(Numeric.fromString(c.v))
	const host = c.s === 0 ? integerOfDecimal(literal) : literal
	if (host === undefined) {
		return "refused"
	}
	const encoded = codec.encode(host)
	return encoded.ok ? Numeric.fromOutput(encoded.value).toString() : "refused"
}

/**
 * Whether the codec parses exactly against PostgreSQL's coercion `host`: it writes the literal's own value only where
 * PostgreSQL stores that value unchanged, and refuses wherever PostgreSQL stores another or refuses it.
 */
export const parsesExactly = (c: Case, host: string, codec: string): boolean => {
	const literal = succeeded(Numeric.fromString(c.v)).toString()
	return codec === "refused" ? host !== literal : codec === literal && host === literal
}

export const typmodSql = "((c.p << 16) | (c.s & 2047)) + 4"

export const typeSql = "format('numeric(%s,%s)', c.p, c.s)"

/**
 * The order, equality and DISTINCT of one batch of numeric spellings on PostgreSQL against the host's values: the
 * spellings travel as written, so PostgreSQL stores their display scales, and the host reads each as its one Numeric.
 */
export const orderAgreement = (db: CaseSession, spellings: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const values = Arr.map(spellings, (text) => Numeric.of(text))
		const payload = jsonText(Arr.map(spellings, (v, ord) => ({ ord, v })))
		const source = "jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text)"
		const ascending = orderOf(values, (a, b) => a.compare(b))
		const descending = orderOf(values, (a, b) => b.compare(a))
		const pgAsc = yield* db.values(
			`SELECT c.ord::text FROM ${source} ORDER BY c.v::numeric, c.ord`,
			[payload]
		)
		const pgDesc = yield* db.values(
			`SELECT c.ord::text FROM ${source} ORDER BY c.v::numeric DESC, c.ord`,
			[payload]
		)
		const pgAscOrder: ReadonlyArray<number> = Arr.map(pgAsc, (r) => Number(r[0]))
		assert.deepEqual(pgAscOrder, ascending)
		const pgDescOrder: ReadonlyArray<number> = Arr.map(pgDesc, (r) => Number(r[0]))
		assert.deepEqual(pgDescOrder, descending)
		const distinct = yield* db.values(`SELECT count(DISTINCT c.v::numeric)::text FROM ${source}`, [
			payload
		])
		const identities = Arr.dedupe(Arr.map(values, (d) => d.text))
		assert.deepEqual(
			Arr.map(distinct, (r) => Number(r[0])),
			[identities.length]
		)
		/** DISTINCT keeps one value per Numeric; its trimmed text is the Numeric's one text. */
		const kept = yield* db.values(`SELECT DISTINCT trim_scale(c.v::numeric)::text FROM ${source}`, [
			payload
		])
		unorderedEqual(
			Arr.map(kept, (r) => String(r[0])),
			identities
		)
		const pairs = Arr.zip(values, Arr.reverse(values))
		const ops = yield* db.values(
			"SELECT (c.a::numeric < c.b::numeric)::text, (c.a::numeric = c.b::numeric)::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, a text, b text) ORDER BY c.ord",
			[jsonText(Arr.map(pairs, ([a, b], ord) => ({ ord, a: a.toString(), b: b.toString() })))]
		)
		assert.deepEqual(
			ops,
			Arr.map(pairs, ([a, b]) => [String(a.compare(b) < 0), String(a.compare(b) === 0)])
		)
	})

/** A numeric spelling: a value's one text, padded by some trailing zeros, or a dictionary spelling. */
export const value: Gen<string> = weighted([
	[4, map(decimalGen, (d) => d.toString())],
	[
		2,
		(source) => {
			const d = source.draw(decimalGen)
			const k = source.draw(element([1, 8, 24, 40]))
			return d.isFinite()
				? `${Str.includes(".")(d.text) ? d.text : `${d.text}.`}${Str.repeat(k)("0")}`
				: d.text
		}
	],
	[1, element(["1.0", "1.00", "-0", "0.000", "NaN", "Infinity", "-Infinity"])]
])
