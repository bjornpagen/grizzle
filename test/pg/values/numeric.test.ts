/**
 * Numeric against PostgreSQL 19: the host's Decimal (scalar/values/decimal.ts) is PostgreSQL's numeric, value for
 * value.
 *
 * - Parse: every literal, decimal digits with a sign, a point and an exponent, its digits weighted toward the 9s, 4s,
 *   5s and 0s rounding turns on, reads as numeric_in reads it: the host's one text is PostgreSQL's trim_scale of it.
 * - Coercion: every literal coerced to numeric(p, s), p and s drawn past their declarable ranges' interesting ends and
 *   literals one digit past p nines at scale s among them, is what both of PostgreSQL's coercion paths make of it,
 *   numeric_in under the typmod and the numeric(numeric, typmod) cast: the same trimmed value, or 22003 where the host
 *   refuses it (normalizeNumeric's numericOverflow or numericInfinity).
 * - Order: PostgreSQL's positions of a batch of numeric spellings, padded with trailing zeros and the special values
 *   among them, under ORDER BY ascending and descending (ties by position) are the host's under Decimal.compare;
 *   count(DISTINCT) and SELECT DISTINCT keep one value per host Decimal; and `<` and `=` over every value paired with
 *   its mirror in the batch are the host's.
 *
 * Oracle: PostgreSQL itself: numeric_in, apply_typmod through both coercion paths, and numeric's comparison.
 *
 * Plants: values-numeric-parse-trailing-zeros (fromString drops a literal's trailing zeros without raising its
 * exponent), values-numeric-overflow-inclusive (normalizeNumeric admits a rounded magnitude of exactly 10^(p - s)),
 * values-numeric-nan-ties-infinity (compareDecimal ranks NaN with +Infinity).
 *
 * Features: "overflow by rounding", "negative scale" and "scale above precision", the coercions the typmod turns on.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { ValueFault } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { assert, contains, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { decimalGen, numericText, orderOf } from "#test/unit/values/support.ts"

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
const caseBatch: Gen<ReadonlyArray<Case>> = map(array(drawnCase, { min: 1, max: 2500 }), (batch) =>
	Arr.map(batch, (c, ord) => ({ ord, ...c }))
)

/**
 * The cases of each literal search: the rotating 6 batches and the floor's 1, about the 10,000 sampled before the
 * search.
 */
const literalRuns = 6

/**
 * What a coercion case reached: an overflow the rounding alone causes, a negative scale, and a scale above the
 * precision.
 */
type CoercionFeature = "overflow by rounding" | "negative scale" | "scale above precision"

/** The refusals of a value numeric(p, s) cannot hold, which PostgreSQL raises as 22003. */
const overflowFaults: ReadonlyArray<ValueFault> = ["numericOverflow", "numericInfinity"]

/**
 * The host's answer: the coerced numeric text, or the SQLSTATE PostgreSQL raises for the refusal (22003 for
 * numeric field overflow and for an infinity under a typmod).
 */
const hostAnswer = (c: Case): string => {
	const normalized = normalizeNumeric(succeeded(Decimal.fromString(c.v)), {
		precision: c.p,
		scale: c.s
	})
	if (normalized.ok) {
		return normalized.value.toString()
	}
	contains(overflowFaults, normalized.error)
	return "22003"
}

const typmodSql = "((c.p << 16) | (c.s & 2047)) + 4"
const typeSql = "format('numeric(%s,%s)', c.p, c.s)"

layer(Substrate.layer)("numeric agreement with PostgreSQL", (it) => {
	it.effect("parses every literal to the value numeric_in gives it, in its one form", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				return yield* explore(
					{
						oracle: { kind: "postgresql", name: "numeric_in, read back by trim_scale" },
						suite: "pg/values/numeric/parse",
						draw: drawn(caseBatch),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: literalRuns,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(chunk) =>
						Effect.gen(function* () {
							const rows = yield* db.values(
								"SELECT c.ord::text, trim_scale(c.v::numeric)::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord",
								[jsonText(Arr.map(chunk, ({ ord, v }) => ({ ord, v })))]
							)
							const mismatches = Arr.filter(
								chunk,
								(c, i) => rows[i]?.[1] !== succeeded(Decimal.fromString(c.v)).toString()
							)
							assert.deepEqual(mismatches.slice(0, 5), [])
						})
				)
			})
		)
	)

	it.effect(
		"normalizes literals to numeric(p, s) exactly as both PostgreSQL coercion paths do",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					return yield* explore(
						{
							oracle: {
								kind: "postgresql",
								name: "numeric_in under a typmod and the numeric(numeric, typmod) cast"
							},
							suite: "pg/values/numeric/coercion",
							draw: drawn(caseBatch),
							literal: Formatter.format,
							coverage: required<CoercionFeature>(
								["overflow by rounding", "negative scale", "scale above precision"],
								{ cases: literalRuns, sense: notesOnly }
							),
							kept: [],
							runs: literalRuns,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(chunk, k) =>
							Effect.gen(function* () {
								const rows = yield* db.values(
									`SELECT c.ord::text,
						CASE WHEN pg_input_is_valid(c.v, ${typeSql})
							THEN trim_scale(numeric_in(c.v::cstring, 1700::oid, ${typmodSql}))::text
							ELSE (pg_input_error_info(c.v, ${typeSql})).sql_error_code END,
						CASE WHEN pg_input_is_valid(c.v, ${typeSql})
							THEN trim_scale(pg_catalog.numeric(c.v::numeric, ${typmodSql}))::text
							ELSE (pg_input_error_info(c.v, ${typeSql})).sql_error_code END
					FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text, p int4, s int4)
					ORDER BY c.ord`,
									[jsonText(Arr.map(chunk, ({ ord, v, p, s }) => ({ ord, v, p, s })))]
								)
								assert.equal(rows.length, chunk.length)
								const mismatches: Array<unknown> = []
								for (const [i, c] of chunk.entries()) {
									const host = hostAnswer(c)
									const [ord, input, cast] = defined(rows[i], `no row for case ${i}`)
									if (ord !== String(c.ord) || input !== host || cast !== host) {
										mismatches.push({ ...c, host, input, cast })
									}
									const x = succeeded(Decimal.fromString(c.v))
									if (host === "22003" && x.isFinite()) {
										/** The unrounded magnitude fits, so the rounding alone overflowed. */
										const fits = normalizeNumeric(x, { precision: 1000, scale: 0 }).ok
										const intDigits = x.parts.coefficient.toString().length - x.parts.minScale
										if (fits && intDigits <= c.p - c.s) {
											k.note("overflow by rounding")
										}
									}
									if (c.s < 0) {
										k.note("negative scale")
									}
									if (c.s > c.p) {
										k.note("scale above precision")
									}
								}
								assert.deepEqual(mismatches.slice(0, 5), [])
							})
					)
				})
			)
	)

	it.effect("orders, equates and deduplicates numerics as PostgreSQL does, NaN last", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				/** A numeric spelling: a value's one text, padded by some trailing zeros, or a dictionary spelling. */
				const value: Gen<string> = weighted([
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
				return yield* explore(
					{
						oracle: {
							kind: "postgresql",
							name: "numeric's ORDER BY, DISTINCT, < and ="
						},
						suite: "pg/values/numeric/order",
						draw: drawn(array(value, { min: 1, max: 3000 })),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 2,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(values) => orderAgreement(db, values)
				)
			})
		)
	)
})

/**
 * The order, equality and DISTINCT of one batch of numeric spellings on PostgreSQL against the host's values: the
 * spellings travel as written, so PostgreSQL stores their display scales, and the host reads each as its one Decimal.
 */
const orderAgreement = (db: RawSession, spellings: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const values = Arr.map(spellings, (text) => Decimal.of(text))
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
		/** DISTINCT keeps one value per Decimal; its trimmed text is the Decimal's one text. */
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
