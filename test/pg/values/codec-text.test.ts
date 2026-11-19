/**
 * A value's one text, a function of its host value alone (codec/scalar.ts hostText, program/text.ts codecText), against
 * PostgreSQL 19 and the pinned pgvector: a batch of values of every carrier with a text, the cases of order.test.ts but
 * bytea, a bytes value being stored only, read at the carrier's type; or of a field of every kind read through
 * codecText, the field as a caller reads it off its relation's value, judged at the type it is declared of, its
 * column's: a caller's field and a generated one of every type with a text, an accumulated one of every value type,
 * drawn(natural), the retirement field, and a closed relation's slot. Each batch is stored under two installations'
 * codes, a fresh one's and one migrated twice, whose rosters' codes have holes.
 *
 * - One text per value: two values of the batch have one text exactly when PostgreSQL's equality of the type holds them
 *   equal, a set's whatever order the caller's Set holds its handles in, its GROUP BY at the value's wire type, so numeric 1.0 and 1.00, NaN and NaN, -0 and +0 are one class each,
 *   a text's under pg_c_utf8, and a closed id's and a set's by their codes, under either installation's.
 * - Read back: PostgreSQL's input function of the type reads each value's text as the value, for every carrier but a
 *   closed id and a set, which PostgreSQL stores as an installation's codes: there the installation's names of the
 *   stored code spell the text, a closed id's handle and a set's handles in declared order, under either installation.
 *
 * Oracle: PostgreSQL itself: each type's equality (GROUP BY) and input function (CAST from text), pgvector's among them,
 * and each installation's codes as PostgreSQL stores them, read back through its names.
 *
 * Features: "texts <carrier>", a carrier's case's; "reads <kind>", a field's case's.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { roundTripRuns } from "#test/pg/codec/scalar.fixtures.ts"
import {
	installationsOf,
	postgresClasses,
	postgresSpelled,
	postgresUnread,
	textBatchGen,
	textCaseOf,
	textClasses,
	type TextFeature,
	textSituations
} from "#test/pg/values/codec-text.fixtures.ts"
import { orderSetup } from "#test/pg/values/order.fixtures.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A value's text is one per value under PostgreSQL's equality, and PostgreSQL reads it back as the value, or, for a
 * closed id and a set, an installation's names spell it from the codes it stores, in a fresh installation and a migrated
 * one alike, whatever kind of field codecText reads it through. Its budget is the codec round trip's per situation
 * (scalar.test.ts roundTripRuns), its runs and steered cases that many times its situations, each a carrier or a kind
 * of field the steered phase reaches.
 */
export const aValuesTextIsOnePerValueUnderPostgreSQLsEqualityAndReadsBackInEveryInstallation =
	property.explore(textBatchGen, {
		needs: { tx: Substrate.transaction },
		situations: textSituations satisfies ReadonlyArray<Reached<TextFeature>>,
		budget: {
			runs: roundTripRuns * textSituations.length,
			steered: roundTripRuns * textSituations.length
		},
		check:
			({ tx }, c: Case<TextFeature>) =>
			(batch) =>
				Effect.gen(function* () {
					const { session, schema } = yield* tx
					const { db, names } = yield* orderSetup(session, schema)
					const carrier = textCaseOf(batch.label)
					const text = carrier.texts(defined(batch.values[0], "a batch holds a value"))
					const texted = Arr.map(batch.values, (value) => ({
						value,
						text: succeeded(text(value), "a drawn value has its text")
					}))
					const texts = Arr.map(texted, (t) => t.text)
					if (carrier.type.carrier === "bits") {
						const reversed = Arr.map(batch.values, (value) =>
							value instanceof Set
								? succeeded(text(new Set(Arr.reverse([...value]))), "a reordered set has its text")
								: assert.fail("a set case draws sets")
						)
						assert.deepEqual(
							reversed,
							texts,
							`${batch.label}: a set's text is one whatever order the caller's Set holds its handles in`
						)
					}
					for (const codes of installationsOf(carrier.type)) {
						const installed = { ...names, codes }
						const classes = yield* postgresClasses(db, installed, carrier.type, batch.values)
						assert.deepEqual(
							textClasses(texts),
							classes,
							`${batch.label}: two values have one text exactly when PostgreSQL holds them equal`
						)
						const type = carrier.type
						if (type.carrier === "code" || type.carrier === "bits") {
							const spelled = yield* postgresSpelled(db, installed, type, batch.values)
							assert.deepEqual(
								spelled,
								texts,
								`${batch.label}: the installation's names of the stored codes spell each text`
							)
						} else {
							const unread = yield* postgresUnread(db, installed, carrier.type, texted)
							assert.deepEqual(
								unread,
								[],
								`${batch.label}: PostgreSQL reads each value's text as the value`
							)
						}
					}
					c.note(carrier.feature)
				}),
		oracle: {
			kind: "postgresql",
			name: "each type's equality, GROUP BY at its wire type, its input function, CAST from text, and an installation's codes read back through its names"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\t\treturn (value) => admitHandle(value, live)",
				replacement:
					'\t\treturn (value) => Result.map(admitHandle(value, live), (h) => String(live.rank.get(h) ?? ""))',
				why: "A closed id's text is its position in its roster's declared order, one per value still and the same in every installation, but no installation's names spell it; the read back fails over a closed id."
			},
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\t\t\tjsonText([...handles].toSorted((a, b) => rankOf(a) - rankOf(b)))",
				replacement: "\t\t\tjsonText([...handles])",
				why: "A set's text lists its handles as the caller's Set holds them, so one set held in two orders has two texts; the property fails over a set."
			},
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\t\treturn scalarCodec(type, emptyCodebook).encode",
				replacement: "\t\treturn (value: unknown) => Result.ok(paramText(String(value)))",
				why: "A value's text is String() of its host value: every vector, span and money value writes [object Object], so unequal ones share a text; the classes fail."
			},
			{
				file: "packages/engine/src/schema/relation.ts",
				original: "\tdescribeFieldOrThrow(declaredDescriptorOf(value), loc)",
				replacement: "\tdescribeFieldOrThrow(value, loc)",
				why: "The one reading of a field as its declared type (describeDeclared) describes the field value itself: a drawn field, which carries no descriptor of its own, is refused (MalformedDescription), and so is every accumulated, retirement, generated and slot field, by codecText and by its relation's column alike; the property fails over each of those kinds."
			},
			{
				file: "packages/engine/src/schema/relation.ts",
				original: '\t\tcase "written":\n\t\t\treturn entry.type',
				replacement:
					'\t\tcase "written":\n\t\t\treturn entry.writing.kind === "accumulated" ? value : entry.type',
				why: "An accumulated field is read from its accumulated(type, start) value, not from its declared type, the one its column is stored and read with: the value is no descriptor a builder registered, so it is refused, every other kind still read as its declared type; the property fails over an accumulated field."
			}
		]
	})
