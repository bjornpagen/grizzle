/**
 * A value's one text read under no installation (codec/scalar.ts declaredCodec, public/text.ts codecText) against
 * PostgreSQL 19 and the pinned pgvector: a batch of values of every carrier with a text, the cases of order.test.ts but
 * bytea, a bytes value being stored only.
 *
 * - One text per value: two values of the batch have one text exactly when PostgreSQL's equality of the type holds them
 *   equal, its GROUP BY at the value's wire type, so numeric 1.0 and 1.00, NaN and NaN, -0 and +0 are one class each,
 *   a text's under pg_c_utf8, and a closed id's and a set's by their codes.
 * - Read back: PostgreSQL's input function of the type reads each value's text as the value, for every carrier but a
 *   closed id and a set, whose texts are a fresh installation's codes, which the cases' installation, a roster with
 *   holes among them, does not hold: their one text per value is all their text states.
 *
 * Oracle: PostgreSQL itself: each type's equality (GROUP BY) and input function (CAST from text), pgvector's among them.
 *
 * Features: "texts <carrier>", every case's.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { declaredCodec } from "#compiler/codec/scalar.ts"
import { roundTripRuns } from "#test/pg/codec/scalar.fixtures.ts"
import {
	postgresClasses,
	postgresUnread,
	readsBack,
	textBatchGen,
	textCases,
	textClasses,
	type TextFeature
} from "#test/pg/values/codec-text.fixtures.ts"
import { orderCaseOf, orderSetup } from "#test/pg/values/order.fixtures.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A value's text is one per value under PostgreSQL's equality, and PostgreSQL reads it back as the value. Its budget is
 * the codec round trip's per carrier (scalar.test.ts roundTripRuns), its runs and steered cases that many times its
 * cases, each case a carrier the steered phase reaches.
 */
export const aValuesTextIsOnePerValueUnderPostgreSQLsEqualityAndPostgreSQLReadsItBackAsTheValue =
	property.explore(textBatchGen, {
		needs: { tx: Substrate.transaction },
		situations: Arr.map(textCases, (c): TextFeature => `texts ${c.label}`) satisfies ReadonlyArray<
			Reached<TextFeature>
		>,
		budget: { runs: roundTripRuns * textCases.length, steered: roundTripRuns * textCases.length },
		check:
			({ tx }, c: Case<TextFeature>) =>
			(batch) =>
				Effect.gen(function* () {
					const { session, schema } = yield* tx
					const { db, names } = yield* orderSetup(session, schema)
					const carrier = orderCaseOf(batch.label)
					const text = declaredCodec(carrier.type).encode
					const texted = Arr.map(batch.values, (value) => ({
						value,
						text: succeeded(text(value), "a drawn value has its text")
					}))
					const classes = yield* postgresClasses(db, names, carrier.type, batch.values)
					assert.deepEqual(
						textClasses(Arr.map(texted, (t) => t.text)),
						classes,
						`${batch.label}: two values have one text exactly when PostgreSQL holds them equal`
					)
					if (readsBack(carrier.type)) {
						const unread = yield* postgresUnread(db, names, carrier.type, texted)
						assert.deepEqual(
							unread,
							[],
							`${batch.label}: PostgreSQL reads each value's text as the value`
						)
					}
					c.note(`texts ${batch.label}`)
				}),
		oracle: {
			kind: "postgresql",
			name: "each type's equality, GROUP BY at its wire type, and its input function, CAST from text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\tscalarCodec(type, firstCodebook(rostersOfType(type)))",
				replacement:
					"\t({ ...scalarCodec(type, firstCodebook(rostersOfType(type))), encode: (value: unknown) => Result.ok(paramText(String(value))) })",
				why: "A value's text is String() of its host value: every set writes [object Set], so two unequal sets share a text; the classes fail over a set."
			},
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\tscalarCodec(type, firstCodebook(rostersOfType(type)))",
				replacement: "\tscalarCodec(type, firstCodebook([]))",
				why: "The text reads no roster's codes, so a closed id's and a set's have none; the property fails over a closed id."
			}
		]
	})
