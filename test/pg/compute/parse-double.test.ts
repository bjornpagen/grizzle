/**
 * Text.parseDouble on PostgreSQL 19: over drawn decimal texts of doubles (test/support/lexical.ts doubleTextGen),
 * weighted at every point binary64's rounding turns on (the greatest finite double and the overflow threshold past it,
 * the least normal, subnormals, half the least subnormal, midpoints between neighbouring doubles, each exactly, cut
 * short and one digit past), digits of up to 40 places and past 700 near either threshold and far past both, signed
 * zeros, the special spellings, and every spelling the form admits, three implementations agree to the bit, -0 apart
 * from +0 and any NaN with any:
 *
 * - IEEE 754-2019's conversion from decimal character sequences written from its definition in exact rational
 *   arithmetic (test/support/oracle/evaluate/double-text.ts), apart from the engine, ECMAScript and PostgreSQL;
 * - grizzle's host evaluator (scalar/compute/evaluate.ts) over the parse as a check lowers it;
 * - the value PostgreSQL stores in an installed relation's generated field `parseDouble(key)`, its key typed by
 *   doubleText, read by float8send: the installer's own DDL, so the parse's SQL is held IMMUTABLE and raising on no
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
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Text.parseDouble on PostgreSQL 19 a stored parse, the host evaluator and IEEE 754's conversion agree to the bit on every double's text.
 *
 * Its pre-conversion budget: runs 100, coverage cases 40 (test/pg/compute/parse-double.test.ts at 22a8e17e9).
 */
export const computeParseDoubleOnPostgreSQL19AStoredParseTheHostEvaluatorAndIEEE754sConversionAgreeToTheBitOnEveryDoublesText =
	property.explore(recorded(array(doubleTextGen, { min: 1, max: 48 }), mapKeyDoubles), {
		needs: { substrate2: Substrate.installing },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, c: Case<Feature>) =>
			(texts) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const installation = yield* parseDoubleInstallation
								const pinned = yield* substrate.admin.pin
								const stored = yield* storedBits(pinned, substrate.database, installation, texts)
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
					Substrate,
					substrate2
				),
		oracle: {
			kind: "second-implementation",
			name: "IEEE 754's decimal-to-binary64 conversion in exact rational arithmetic, against the host evaluator and a stored generated field"
		},
		budget: { runs: 100, steered: 40 },
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
		kills: []
	})
