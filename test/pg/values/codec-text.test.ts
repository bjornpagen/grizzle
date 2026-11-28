/**
 * A value's one text, a function of its host value alone (codec/scalar.ts hostText, program/text.ts codecText), against
 * PostgreSQL 19 and the pinned pgvector: a batch of values of every carrier with a text, the cases of order.test.ts but
 * bytea, a bytes value being stored only, read at the carrier's type; or of a field of every kind read through
 * codecText, the field as a caller reads it off its relation's value, judged at the type it is declared of, its
 * column's: a caller's field and a generated one of every type with a text, an accumulated one of every value type,
 * drawn(natural) and a closed relation's slot. Each batch is stored under two installations'
 * codes, a fresh one's and one migrated twice, whose rosters' codes have holes.
 *
 * - One text per value: two values of the batch have one text exactly when PostgreSQL holds them one value, a set's
 *   whatever order the caller's Set holds its handles in: its equality of the type, its GROUP BY at the value's wire
 *   type, so numeric 1.0 and 1.00 are one class and NaN and NaN another, a text's under pg_c_utf8, and a closed id's and
 *   a set's by their codes, under either installation's; but a float's -0 and +0, which its equality holds equal, are
 *   two values, as grizzle keeps a zero's sign end to end (scalar/values/float.ts), and its binary image tells them
 *   apart (codec-text.fixtures.ts identifiedBy).
 * - Read back: PostgreSQL's input function of the type reads each value's text as the value, for every carrier but a
 *   closed id and a set, which PostgreSQL stores as an installation's codes: there the installation's names of the
 *   stored code spell the text, a closed id's handle and a set's handles in declared order, under either installation.
 *
 * Oracle: PostgreSQL itself: each type's equality (GROUP BY), a float's binary image (float8send) beside it, and input
 * function (CAST from text), pgvector's among them, and each installation's codes as PostgreSQL stores them, read back
 * through its names.
 *
 * Features: "texts <carrier>", a carrier's case's; "reads <kind>", a field's case's.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
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
import { succeeded } from "#test/support/assert.ts"
import { roundTripRuns } from "#test/support/pg/codec/scalar.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A value's text is one per value as PostgreSQL holds its values, and PostgreSQL reads it back as the value, or, for a
 * closed id and a set, an installation's names spell it from the codes it stores, in a fresh installation and a migrated
 * one alike, whatever kind of field codecText reads it through. Its budget is the codec round trip's per situation
 * (scalar.test.ts roundTripRuns), its runs and steered cases that many times its situations, each a carrier or a kind
 * of field the steered phase reaches.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/values/codec-text.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/values/codec-text.test.ts` at its budget
 *   before, `{ runs: roundTripRuns * textSituations.length, steered: roundTripRuns * textSituations.length }`, each
 *   kill's verdict printed with where its witnesses went red (judgedLine with the red's headline, a local print), in
 *   ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its 6 kills went red on case 27 of its floor stream, case 7 of its floor stream, case 8 of its floor stream,
 *   case 0 of its floor stream, case 7 of its floor stream and case 16 of its floor stream, in the order it declares
 *   them
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 28 cases: 109; no
 *   headroom: a kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const aValuesTextIsOnePerValueAndReadsBackInEveryInstallation = property.explore(
	textBatchGen,
	{
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: textSituations satisfies ReadonlyArray<Reached<TextFeature>>,
		budget: { runs: 109, steered: roundTripRuns * textSituations.length },
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
							`${batch.label}: two values have one text exactly when PostgreSQL holds them one value`
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
			name: "each type's equality, GROUP BY at its wire type, a float's binary image beside it, its input function, CAST from text, and an installation's codes read back through its names"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\treturn scalarCodec(type, emptyCodebook).encode",
				replacement:
					'\treturn (value: unknown) => Result.map(scalarCodec(type, emptyCodebook).encode(value), (t) => (t === "-0" ? "0" : t))',
				why: "A value's text is its key text, a float's -0 written 0 as a key compares it (scalar/values/identity.ts keyText), where its identity text keeps the zero's sign: -0 and +0, two values whose binary images PostgreSQL tells apart, share a text, and PostgreSQL reads that text as +0; the property fails over a float."
			},
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\treturn (value) => admitSubsetHandle(value, live, only)",
				replacement:
					'\treturn (value) => Result.map(admitSubsetHandle(value, live, only), (h) => String(live.rank.get(h) ?? ""))',
				why: "A closed id's text is its position in its roster's declared order, one per value still and the same in every installation, but no installation's names spell it; the read back fails over a closed id."
			},
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\t\t\t[...handles].toSorted((a, b) => rankOf(a) - rankOf(b))",
				replacement: "\t\t\t[...handles]",
				why: "A set's text lists its handles as the caller's Set holds them, so one set held in two orders has two texts; the property fails over a set."
			},
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\treturn scalarCodec(type, emptyCodebook).encode",
				replacement: "\treturn (value: unknown) => Result.ok(paramText(String(value)))",
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
				original:
					'\tfieldEntries.set(value, { kind: "written", writing: { kind: "accumulated", start: literal } })\n\tregisterWrittenField(value, type)\n',
				replacement:
					'\tfieldEntries.set(value, { kind: "written", writing: { kind: "accumulated", start: literal } })\n',
				why: "An accumulated field registers no type its values are of (scalar/registry.ts registerWrittenField), so it is read as no declared type, not the one its column is stored and read with: it is refused, every other kind still read as its declared type; the property fails over an accumulated field."
			}
		]
	}
)
