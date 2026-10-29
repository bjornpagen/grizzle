import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, String as Str } from "effect"
import type { ValueFault } from "#compiler/core/errors.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { assert, contains, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { jsonText } from "#test/support/json.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { decimalGen, decimalText, orderOf } from "#test/unit/values/support.ts"

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
			v: source.draw(decimalText),
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
	it.effect("parses every literal to the value and display scale numeric_in gives it", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				return yield* explore(
					{
						suite: "pg/values/numeric/parse",
						draw: drawn(caseBatch),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: literalRuns,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(chunk) =>
						Effect.gen(function* () {
							const rows = yield* db.values(
								"SELECT c.ord::text, c.v::numeric::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord",
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
							suite: "pg/values/numeric/coercion",
							draw: drawn(caseBatch),
							literal: Formatter.format,
							features: features<CoercionFeature>([
								"overflow by rounding",
								"negative scale",
								"scale above precision"
							]),
							kept: [],
							runs: literalRuns,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						(chunk, k) =>
							Effect.gen(function* () {
								const rows = yield* db.values(
									`SELECT c.ord::text,
						CASE WHEN pg_input_is_valid(c.v, ${typeSql})
							THEN numeric_in(c.v::cstring, 1700::oid, ${typmodSql})::text
							ELSE (pg_input_error_info(c.v, ${typeSql})).sql_error_code END,
						CASE WHEN pg_input_is_valid(c.v, ${typeSql})
							THEN pg_catalog.numeric(c.v::numeric, ${typmodSql})::text
							ELSE (pg_input_error_info(c.v, ${typeSql})).sql_error_code END
					FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text, p int4, s int4)
					ORDER BY c.ord`,
									[jsonText(chunk)]
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
										const intDigits = x.coefficient.toString().length - x.scale
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
				const value = weighted([
					[6, decimalGen],
					[
						1,
						map(element(["1.0", "1.00", "-0", "0.000", "NaN", "Infinity", "-Infinity"]), (text) =>
							Decimal.of(text)
						)
					]
				])
				return yield* explore(
					{
						suite: "pg/values/numeric/order",
						draw: drawn(array(value, { min: 1, max: 3000 })),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 2,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(values) => orderAgreement(db, values)
				)
			})
		)
	)
})

/** The order, equality and DISTINCT of one batch of numerics on PostgreSQL against the host's. */
const orderAgreement = (db: RawSession, values: ReadonlyArray<Decimal>) =>
	Effect.gen(function* () {
		const payload = jsonText(Arr.map(values, (d, ord) => ({ ord, v: d.toString() })))
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
		const identities = Arr.dedupe(Arr.map(values, (d) => d.identityText()))
		assert.deepEqual(
			Arr.map(distinct, (r) => Number(r[0])),
			[identities.length]
		)
		/** DISTINCT keeps one value per identity text; its trimmed text is the identity text. */
		const kept = yield* db.values(`SELECT DISTINCT trim_scale(c.v::numeric)::text FROM ${source}`, [
			payload
		])
		unorderedEqual(
			Arr.map(kept, (r) => String(r[0])),
			identities
		)
		/** Pairwise comparison operators. */
		const pairs = Arr.map(
			values.slice(0, 1500),
			(a, i) =>
				[a, defined(values[values.length - 1 - i], `no value ${values.length - 1 - i}`)] as const
		)
		const ops = yield* db.values(
			"SELECT (c.a::numeric < c.b::numeric)::text, (c.a::numeric = c.b::numeric)::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, a text, b text) ORDER BY c.ord",
			[jsonText(Arr.map(pairs, ([a, b], ord) => ({ ord, a: a.toString(), b: b.toString() })))]
		)
		assert.deepEqual(
			ops,
			Arr.map(pairs, ([a, b]) => [String(a.compare(b) < 0), String(a.compare(b) === 0)])
		)
	})
