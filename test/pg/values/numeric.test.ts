/**
 * Numeric against PostgreSQL 19: the host's Decimal (scalar/values/decimal.ts) is PostgreSQL's numeric, value for
 * value.
 *
 * - Parse: every literal, decimal digits with a sign, a point and an exponent, its digits weighted toward the 9s, 4s,
 *   5s and 0s rounding turns on, reads as numeric_in reads it: the host's one text is PostgreSQL's trim_scale of it.
 * - Coercion: every literal coerced to numeric(p, s), p and s drawn past their declarable ranges' interesting ends and
 *   literals one digit past p nines at scale s among them, is what both of PostgreSQL's coercion paths make of it,
 *   numeric_in under the typmod and the numeric(numeric, typmod) cast: the same trimmed value, or 22003 where the host
 *   refuses it (normalizeNumeric's numericOverflow or numericInfinity); and the numeric(p, s) codec's encoder
 *   (codec/scalar.ts), the exact parse, writes the literal's own value exactly where PostgreSQL stores it unchanged,
 *   and refuses it wherever PostgreSQL would store another value or refuse it.
 * - Order: PostgreSQL's positions of a batch of numeric spellings, padded with trailing zeros and the special values
 *   among them, under ORDER BY ascending and descending (ties by position) are the host's under Decimal.compare;
 *   count(DISTINCT) and SELECT DISTINCT keep one value per host Decimal; and `<` and `=` over every value paired with
 *   its mirror in the batch are the host's.
 *
 * Oracle: PostgreSQL itself: numeric_in, apply_typmod through both coercion paths, and numeric's comparison.
 *
 * Features: "overflow by rounding", "negative scale" and "scale above precision", the coercions the typmod turns on.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import {
	caseBatch,
	codecAnswer,
	type CoercionFeature,
	hostAnswer,
	orderAgreement,
	parsesExactly,
	typeSql,
	typmodSql,
	value
} from "#test/pg/values/numeric.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Numeric agreement with PostgreSQL parses every literal to the value numeric_in gives it, in its one form. */
export const numericAgreementWithPostgreSQLParsesEveryLiteralToTheValueNumericInGivesItInItsOneForm =
	property.explore(caseBatch, {
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 6, no coverage (numeric.test.ts at 4fbc3e95). */
		budget: { runs: 6, steered: 0 },
		check:
			({ tx }) =>
			(chunk) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

					const rows = yield* db.values(
						"SELECT c.ord::text, trim_scale(c.v::numeric)::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord",
						[jsonText(Arr.map(chunk, ({ ord, v }) => ({ ord, v })))]
					)
					const mismatches = Arr.filter(
						chunk,
						(c, i) => rows[i]?.[1] !== succeeded(Decimal.fromString(c.v)).toString()
					)
					assert.deepEqual(mismatches.slice(0, 5), [])
				}),
		oracle: { kind: "postgresql", name: "numeric_in, read back by trim_scale" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\t\tconst exponent = written.value.value - fractionLength + (all.length - end)",
				replacement: "\t\tconst exponent = written.value.value - fractionLength",
				why: "fromString drops a literal's trailing zeros without raising its exponent."
			}
		]
	})

/** Numeric agreement with PostgreSQL normalizes literals to numeric(p, s) exactly as both PostgreSQL coercion paths do, and the codec parses exactly. */
export const numericAgreementWithPostgreSQLNormalizesLiteralsToNumericPSExactlyAsBothPostgreSQLCoercionPathsDoAndTheCodecParsesExactly =
	property.explore(caseBatch, {
		needs: { tx: Substrate.transaction },
		situations: [
			"overflow by rounding",
			"negative scale",
			"scale above precision"
		] satisfies ReadonlyArray<Reached<CoercionFeature>>,
		/** Its pre-conversion budget: runs 6, coverage cases 6 (numeric.test.ts at 4fbc3e95). */
		budget: { runs: 6, steered: 6 },
		check:
			({ tx }, k: CaseOf<CoercionFeature>) =>
			(chunk) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

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
						const codec = codecAnswer(c)
						const [ord, input, cast] = defined(rows[i], `no row for case ${i}`)
						if (
							ord !== String(c.ord) ||
							input !== host ||
							cast !== host ||
							!parsesExactly(c, host, codec)
						) {
							mismatches.push({ ...c, host, codec, input, cast })
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
				}),
		oracle: {
			kind: "postgresql",
			name: "numeric_in under a typmod and the numeric(numeric, typmod) cast"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\t(units < 0n ? -units : units) < pow10(precision)",
				replacement: "\t(units < 0n ? -units : units) <= pow10(precision)",
				why: "The typmod's precision check admits a magnitude of exactly 10^p units, 10^(p - s): normalizeNumeric stores what the column refuses."
			},
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: '\t\t\t\t: { carrier: "numeric", typmod: type.typmod }',
				replacement: '\t\t\t\t: { carrier: "numeric", typmod: undefined }',
				why: "The numeric codec's carrier spec drops its typmod, so its encoder admits a value its column rounds."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tnumeric: (value, spec) => decimalAt(parseNumeric)(value, spec.typmod),",
				replacement: "\tnumeric: (value, spec) => decimalAt(normalizeNumeric)(value, spec.typmod),",
				why: "The encoder rounds to the scale where it must refuse."
			},
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tconst units = exactUnits(d, typmod.scale)",
				replacement: "\tconst units = exactUnits(d, typmod.scale - 1)",
				why: "parseNumeric reads a value at one place less than its typmod's scale, so the encoder refuses a value whose fraction fills the scale, which PostgreSQL stores unchanged."
			}
		]
	})

/** Numeric agreement with PostgreSQL orders, equates and deduplicates numerics as PostgreSQL does, NaN last. */
export const numericAgreementWithPostgreSQLOrdersEquatesAndDeduplicatesNumericsAsPostgreSQLDoesNaNLast =
	property.explore(array(value, { min: 1, max: 3000 }), {
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 2, no coverage (numeric.test.ts at 4fbc3e95). */
		budget: { runs: 2, steered: 0 },
		check:
			({ tx }) =>
			(values) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					return yield* orderAgreement(db, values)
				}),
		oracle: {
			kind: "postgresql",
			name: "numeric's ORDER BY, DISTINCT, < and ="
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\t\t\treturn 3",
				replacement: "\t\t\treturn 2",
				why: "compareDecimal ranks NaN with +Infinity."
			}
		]
	})
