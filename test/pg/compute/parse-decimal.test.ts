/**
 * Text.parseNumeric on PostgreSQL 19: over drawn pairs of decimal texts (test/support/lexical.ts decimalTextGen),
 * each part's count of digits at an edge the parse turns on (256 integer and 255 fraction digits, the widest
 * numeric(p, s) form's, and the form's own 16,384 bytes, numeric's 16,383 fraction digits among them), leading and
 * trailing zeros, signs, bare fractions, trailing points and zeros, the second of a pair the first's value spelled
 * again, one unit either side in its last place, negated, moved a place, or drawn apart, three implementations agree
 * exactly:
 *
 * - XML Schema 1.1's decimal lexical and canonical mappings written from their definition in BigInt
 *   (test/support/oracle/evaluate/decimal-text.ts), apart from the engine and PostgreSQL;
 * - grizzle's host evaluator (scalar/compute/evaluate.ts) over the parse as a check lowers it;
 * - PostgreSQL: the parse's SQL as a check lowers it, over every text, read by numeric_out; and an installed relation of
 *   the downstream's range shape, its two texts typed str.bytes(16384, str.regex(numericText)), whose generated fields
 *   store whether the first's value is below the second's and whether they are one value, and the first's value itself
 *   where a guard bounds its text within 500 bytes, cast into numeric(1000, 499), which that bound proves it fits.
 *
 * The oracle is the reference mapping. Bound: up to 24 pairs a case, each case one installation in a transaction rolled
 * back.
 *
 * Features: each digit-count edge and each relation of a pair's second text to its first.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, recorded } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	type Feature,
	features,
	hostValue,
	parseDecimalInstallation,
	pairGen,
	parseSql,
	printed,
	sameDecimalValue,
	storedBytes,
	storedRows,
	textFeatures,
	valueOf,
	ariaRanges
} from "#test/pg/compute/parse-decimal.fixtures.ts"
import { canonicalDecimal, decimalOrder } from "#test/support/oracle/evaluate/decimal-text.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Text.parseNumeric on PostgreSQL 19 the parse's SQL, a stored range, the host evaluator and XML Schema's decimal mapping agree exactly on every decimal text.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/parse-decimal.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/parse-decimal.test.ts` at its budget
 *   before, `{ runs: 100, steered: 40 }`, each kill's verdict printed with where its witnesses went red (judgedLine
 *   with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget
 *   run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on its kept case
 * @decision 1, the least a generative search draws: no declared kill needs a floor or a rotating case; no headroom: a
 *   kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const computeParseDecimalOnPostgreSQL19TheParsesSQLAStoredRangeTheHostEvaluatorAndXMLSchemasDecimalMappingAgreeExactlyOnEveryDecimalText =
	property.explore(recorded(array(pairGen, { min: 1, max: 24 }), ariaRanges), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ tx }, c: Case<Feature>) =>
			(pairs) =>
				Effect.gen(function* () {
					const { connection, database, schema, session: db } = yield* tx
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const texts = Arr.flatMap(pairs, (pair) => [pair.low, pair.high])
							const computed = yield* db.values(
								`SELECT (${parseSql})::text FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text) ORDER BY r0.ord`,
								[jsonText(Arr.map(texts, (text, ord) => ({ ord, v: text })))]
							)
							assert.equal(computed.length, texts.length, "a value per text")
							for (const [i, text] of texts.entries()) {
								const reference = valueOf(text)
								const label = `${Formatter.format(text)}: reference ${canonicalDecimal(reference)}`
								const host = hostValue(text)
								const database = printed(defined(computed[i], "its row")[0])
								assert.ok(
									sameDecimalValue(host, reference),
									`${label}, host ${canonicalDecimal(host)}`
								)
								assert.ok(
									sameDecimalValue(database, reference),
									`${label}, PostgreSQL ${canonicalDecimal(database)}`
								)
								c.noteAll(textFeatures(text))
							}
							const schemaName = yield* schema("parse_decimal")
							const installation = yield* parseDecimalInstallation(schemaName)
							const rows = yield* storedRows(connection, database, installation, pairs)
							assert.equal(rows.length, pairs.length, "a row per pair")
							for (const [i, pair] of pairs.entries()) {
								const row = defined(rows[i], "its stored row")
								const order = decimalOrder(valueOf(pair.low), valueOf(pair.high))
								const label = `${Formatter.format(pair)}: order ${order}`
								assert.equal(row.below, order < 0 ? "true" : "false", `${label}, below`)
								assert.equal(row.same, order === 0 ? "true" : "false", `${label}, same`)
								if (pair.low.length <= storedBytes) {
									assert.ok(
										sameDecimalValue(printed(row.stored), valueOf(pair.low)),
										`${label}, stored ${row.stored}`
									)
									c.note("a value stored")
								}
								if (order === 0 && pair.low !== pair.high) {
									c.note("one value spelled twice")
								}
								if (order > 0) {
									c.note("a pair out of order")
								}
							}
						})
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "XML Schema 1.1's decimal lexical mapping in BigInt, against the host evaluator, the parse's SQL and a stored range's generated fields"
		},
		budget: { runs: 1, steered: 40 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/compute/parse-decimal.test.ts#computeParseDecimalOnPostgreSQL19TheParsesSQLAStoredRangeTheHostEvaluatorAndXMLSchemasDecimalMappingAgreeExactlyOnEveryDecimalText:-:1"
				),
				reason:
					"the downstream's ARIA value range past numeric(511, 255)'s form, whose texts read as an infinity of their sign and passed the range rule, recorded (ariaRanges)",
				since: "2026-11-08"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original:
					"\tif (n === undefined || text.length > numericTextMaxBytes) {\n\t\treturn undefined\n\t}\n\tconst { units, scale } = unitsOf(n)\n",
				replacement:
					"\tif (n === undefined || text.length > numericTextMaxBytes) {\n\t\treturn undefined\n\t}\n\treturn decimalValue(text, { precision: 511, scale: 255 })\n\tconst { units, scale } = unitsOf(n)\n",
				why: "91f8347df's fix reverted on the host: the parse reads a decimal text only within numeric(511, 255)'s form, the widest a pattern counted before it, so the downstream's range past 256 integer or 255 fraction digits has no host value where PostgreSQL's numeric reads it exactly."
			}
		]
	})
