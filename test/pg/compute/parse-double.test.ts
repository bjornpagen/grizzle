/**
 * Text.parseFloat8 on PostgreSQL 19: over drawn decimal texts of doubles (test/support/lexical.ts doubleTextGen),
 * weighted at every point binary64's rounding turns on (the greatest finite double and the overflow threshold past it,
 * the least normal, subnormals, half the least subnormal, midpoints between neighbouring doubles, each exactly, cut
 * short and one digit past), digits of up to 40 places and past 700 near either threshold and far past both, signed
 * zeros, the special spellings, and every spelling the form admits, three implementations agree to the bit, -0 apart
 * from +0 and any NaN with any:
 *
 * - IEEE 754-2019's conversion from decimal character sequences written from its definition in exact rational
 *   arithmetic (test/support/oracle/evaluate/double-text.ts), apart from the engine, ECMAScript and PostgreSQL;
 * - grizzle's host evaluator (scalar/compute/evaluate.ts) over the parse as a check lowers it;
 * - the value PostgreSQL stores in an installed relation's generated field `parseFloat8(key)`, its key typed by
 *   float8Text, read by float8send: the installer's own DDL, so the parse's SQL is held IMMUTABLE and raising on no
 *   member as a generation expression, every drawn row inserted.
 *
 * The oracle is the reference conversion. Bound: up to 48 texts a case, each case one installation in a transaction
 * rolled back.
 *
 * Features: each rounding point and spelling the form admits.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, recorded } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type Feature,
	features,
	featuresOf,
	hostBits,
	parseDoubleInstallation,
	storedBits,
	mapKeyDoubles
} from "#test/pg/compute/parse-double.fixtures.ts"
import { doubleTextGen } from "#test/support/lexical.ts"
import { referenceConversion, sameDouble } from "#test/support/oracle/evaluate/double-text.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Text.parseFloat8 on PostgreSQL 19 a stored parse, the host evaluator and IEEE 754's conversion agree to the bit on every double's text.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/parse-double.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/parse-double.test.ts` at its budget
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
export const computeParseDoubleOnPostgreSQL19AStoredParseTheHostEvaluatorAndIEEE754sConversionAgreeToTheBitOnEveryDoublesText =
	property.explore(recorded(array(doubleTextGen, { min: 1, max: 48 }), mapKeyDoubles), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ tx }, c: Case<Feature>) =>
			(texts) =>
				Effect.gen(function* () {
					const { bare, database, schema } = yield* tx
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const schemaName = yield* schema("parse_double")
							const installation = yield* parseDoubleInstallation(schemaName)
							const stored = yield* storedBits(bare, database, installation, texts)
							assert.equal(stored.length, texts.length, "a row per text")
							for (const [i, text] of texts.entries()) {
								const reference = defined(referenceConversion(text), "a member of the form")
								const host = hostBits(text)
								const database = defined(stored[i], "its stored value")
								const label = `${Formatter.format(text)}: reference ${reference.bits.toString(16)}`
								assert.ok(sameDouble(host, reference.bits), `${label}, host ${host.toString(16)}`)
								assert.ok(
									sameDouble(database, reference.bits),
									`${label}, PostgreSQL ${database.toString(16)}`
								)
								c.noteAll(featuresOf(text, reference))
							}
						})
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "IEEE 754's decimal-to-binary64 conversion in exact rational arithmetic, against the host evaluator and a stored generated field"
		},
		budget: { runs: 1, steered: 40 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/compute/parse-double.test.ts#computeParseDoubleOnPostgreSQL19AStoredParseTheHostEvaluatorAndIEEE754sConversionAgreeToTheBitOnEveryDoublesText:-:1"
				),
				reason:
					"qti-pie's xs:double map keys, each refused before by the cast's bounded form, recorded (mapKeyDoubles)",
				since: "2026-11-07"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original: 'isDoubleText(text) ? Number(text.replace("INF", "Infinity")) : undefined',
				replacement:
					'isDoubleText(text) && doubleValue(text, () => 0) !== undefined ? Number(text.replace("INF", "Infinity")) : undefined',
				why: "b0e98c456's fix reverted on the host: the parse reads a double's text only within the cast's bounded form, fifteen digits and its exponent bound, so qti-pie's keys past it have no host value where PostgreSQL's parse reads them."
			}
		]
	})
