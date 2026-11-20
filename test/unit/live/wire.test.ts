/**
 * The wire's one table (live/wire.ts carrierWire): each carrier's JSON Schema, encode, exact parse and trusting decode
 * agree, over drawn specs of every carrier and drawn values of each spec's type.
 *
 * - Codec output: every value of a spec's type encodes to JSON its schema admits, as its one form does (a float as it
 *   is, -0 spelled by its word; a vector component's one zero, -0 as 0), which the parse reads back as that one form and
 *   the decode converts back to it. Oracle: the schema, judged by the validator the CLI generator pins
 *   (test/support/openapi/validator.ts), and the value's one form, compared by live/key.ts sameValue (Object.is).
 * - Exactness: over JSON near a value's spelling (one edit of its encoding, or a JSON value of another kind), the parse
 *   reads nothing its schema refuses, and every JSON its schema admits that the parse refuses is refused as one of the
 *   gaps that schema lists (`x-grizzle-gaps`), each named as its fault is (wireFaults, schemaGaps). Oracle: the schema
 *   and its enumerated gaps, the specification of what the wire's parse takes.
 * - The host door: the wire's parse reads exactly what the host door (scalar/values/identity.ts parseValue, every
 *   caller's value's one door) reads: every value of a type the host door reads, its one form unchanged, the wire reads
 *   back from its JSON as that one form, and every JSON the wire reads, the host door reads, its one form unchanged.
 *   Oracle: a differential with parseValue.
 *
 * Features: every carrier, a numeric under a typmod and a computed numeric, a negative scale, a scale past the
 * precision, zero of a numeric below one, NaN and the infinities of a float, a fixed-width span, a set of handles, a
 * negative zero, a JSON refused by schema and parse alike, a JSON a schema admits and the parse refuses as a gap.
 *
 * Kept: the live test phase's counterexamples at 729f76a6, a vector holding a -0 component, which the oracle compared
 * by Object.is to the 0 the wire spells it as; and at 9ef5c380, zero of a computed numeric below one and "0" read as a
 * numeric(1, 2), whose parse raised 10 to a negative power.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { carriers } from "#compiler/ir/scalar.ts"
import { sameValue } from "#compiler/live/key.ts"
import { decodeScalar, encodeScalar, parseScalar, scalarSchema } from "#compiler/live/wire.ts"
import { parseValue } from "#compiler/scalar/values/identity.ts"
import { succeeded } from "#test/support/assert.ts"
import { schemaAdmits } from "#test/support/openapi/validator.ts"
import {
	carrierSpecOf,
	caseSpace,
	type Feature,
	featuresOf,
	gapsOf,
	hostForm,
	isFault,
	nearCaseGen,
	oneForm
} from "#test/unit/live/wire.fixtures.ts"

/**
 * The wire's one table encodes every value of a type to JSON its schema admits, which the parse and the decode read
 * back.
 *
 * Budget: its suite's count before the conversion (unit/live/wire-codec: 1500 independent cases and 400 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theWiresOneTableEncodesEveryValueOfATypeToJSONItsSchemaAdmitsWhichTheParseAndTheDecodeReadBack =
	property.explore(caseSpace, {
		needs: {},
		situations: [
			...Arr.map(carriers, (carrier): Feature => `the carrier ${carrier}`),
			"a numeric under a typmod",
			"a computed numeric",
			"a negative scale",
			"a scale past the precision",
			"zero of a numeric below one",
			"a float's NaN or infinity",
			"a fixed-width span",
			"a set of handles",
			"a negative zero"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: Case<Feature>) => (c) =>
			Effect.gen(function* () {
				notes.noteAll(featuresOf(c))
				const json = encodeScalar(c.spec, c.value)
				const schema = scalarSchema(c.spec)
				const admitted = yield* schemaAdmits(schema, json, 0)
				assert.ok(
					admitted,
					`the schema ${Formatter.format(schema)} admits ${Formatter.format(json)}`
				)
				const parsed = succeeded(
					parseScalar(c.spec, json),
					`the parse reads ${Formatter.format(json)}`
				)
				assert.ok(
					sameValue(json, encodeScalar(c.spec, oneForm(c.value))),
					"the value encodes as its one form does, -0 as 0"
				)
				assert.ok(sameValue(parsed, oneForm(c.value)), "the parse reads back the value's one form")
				assert.ok(
					sameValue(decodeScalar(c.spec, json), oneForm(c.value)),
					"the decode converts back the value's one form"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the carrier's JSON Schema, judged by the pinned validator, and the value itself by its one form"
		},
		budget: { runs: 1500, steered: 400 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/live/wire.test.ts#theWiresOneTableEncodesEveryValueOfATypeToJSONItsSchemaAdmitsWhichTheParseAndTheDecodeReadBack:-:h.5.1.0.1.1.1.0.1.0.1.0.1.0"
				),
				reason:
					"a vector holding a -0 component, spelled and read back as 0 (wire-codec, live test phase 729f76a6)",
				since: "2026-11-11"
			},
			{
				token: ReplayToken(
					"test/unit/live/wire.test.ts#theWiresOneTableEncodesEveryValueOfATypeToJSONItsSchemaAdmitsWhichTheParseAndTheDecodeReadBack:-:3.0.2.0"
				),
				reason:
					"zero of a computed numeric below one, whose parse raised 10 to a negative power (wire-codec, live test phase 9ef5c380)",
				since: "2026-11-11"
			}
		],
		kills: [
			{
				file: "packages/engine/src/live/wire.ts",
				original: "\t\tschema: () => spelled(integers(int8Min, int8Max)),",
				replacement:
					'\t\tschema: () => ({ type: "integer", minimum: Number(int8Min), maximum: Number(int8Max) }),',
				why: "int8's schema is a JSON integer, its values still strings."
			},
			{
				file: "packages/engine/src/live/wire.ts",
				original: "\t\tencode: (value) => Array.from(value, (x) => (x === 0 ? 0 : x)),",
				replacement: "\t\tencode: (value) => Array.from(value, (x) => x),",
				why: "A vector's -0 component is spelled as -0."
			}
		]
	})

/**
 * The wire's one table parses nothing its schema refuses, and refuses what its schema admits only as one of the
 * schema's gaps.
 *
 * Budget: its suite's count before the conversion (unit/live/wire-exact: 3000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theWiresOneTableParsesNothingItsSchemaRefusesAndRefusesWhatItsSchemaAdmitsOnlyAsOneOfTheSchemasGaps =
	property.explore(nearCaseGen, {
		needs: {},
		situations: [
			...Arr.map(carriers, (carrier): Feature => `the carrier ${carrier}`),
			"a JSON refused by schema and parse alike",
			"a JSON the schema admits and the parse refuses as a gap"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: Case<Feature>) => (c) =>
			Effect.gen(function* () {
				notes.note(`the carrier ${c.spec.carrier}`)
				const schema = scalarSchema(c.spec)
				const admitted = yield* schemaAdmits(schema, c.near, 0)
				const parsed = parseScalar(c.spec, c.near)
				if (parsed.ok) {
					assert.ok(
						admitted,
						`the parse reads ${Formatter.format(c.near)}, which ${Formatter.format(schema)} refuses`
					)
					return
				}
				assert.ok(isFault(parsed.error), `the parse's refusal ${parsed.error} is a WireFaultKind`)
				if (!admitted) {
					notes.note("a JSON refused by schema and parse alike")
					return
				}
				const gaps = gapsOf(schema)
				assert.ok(
					Arr.some([...gaps], (gap) => gap === parsed.error),
					`the schema admits ${Formatter.format(c.near)}, which the parse refuses as ${parsed.error}, no gap of ${Arr.join([...gaps], ", ")}`
				)
				notes.note("a JSON the schema admits and the parse refuses as a gap")
			}),
		oracle: {
			kind: "specification",
			name: "the carrier's JSON Schema and the gaps it lists, the language the wire's parse takes"
		},
		budget: { runs: 3000, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/live/wire.test.ts#theWiresOneTableParsesNothingItsSchemaRefusesAndRefusesWhatItsSchemaAdmitsOnlyAsOneOfTheSchemasGaps:-:3.1.i.1.j.1.2.0.0.0.7.0"
				),
				reason:
					'"0" read as a numeric(19, 20), whose parse raised 10 to a negative power (wire-exact, live test phase 9ef5c380)',
				since: "2026-11-11"
			}
		],
		kills: [
			{
				file: "packages/text/src/regex/print.ts",
				original: "\tintervals: (set) => set,",
				replacement: "\tintervals: printableIntervals,",
				why: "The ECMA dialect closes the surrogate gap as the ARE does: the text schema admits a lone surrogate, which the parse refuses as text and no gap names."
			},
			{
				file: "packages/engine/src/live/pattern.ts",
				original:
					'\t\tintegerDigits >= 1 ? b.alt([literal("0"), leading(integerDigits - 1)]) : literal("0")',
				replacement:
					'\t\tintegerDigits >= 1 ? b.alt([literal("0"), leading(integerDigits)]) : literal("0")',
				why: "A decimal's schema admits one integer digit more than its type holds, which the parse refuses as range and no gap names."
			},
			{
				file: "packages/engine/src/ir/date.ts",
				original: "\tif (days === undefined || day < 1 || day > days) {",
				replacement: "\tif (days === undefined || day < 1 || day <= days) {",
				why: "Operator mutant (comparison) at packages/engine/src/ir/date.ts:102 in toCalendarDate: `>` becomes `<=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The wire's one table parses to exactly what the host door parses: every value it reads the host door reads
 * unchanged, and every value of a type reads back from its JSON.
 *
 * Budget: its suite's count before the conversion (unit/live/wire-host-door: 2000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theWiresOneTableParsesToExactlyWhatTheHostDoorParsesEveryValueItReadsTheHostDoorReadsUnchangedAndEveryValueOfATypeReadsBackFromItsJSON =
	property.explore(nearCaseGen, {
		needs: {},
		situations: Arr.map(
			carriers,
			(carrier): Feature => `the carrier ${carrier}`
		) satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: Case<Feature>) => (c) =>
			Effect.sync(() => {
				notes.note(`the carrier ${c.spec.carrier}`)
				const door = carrierSpecOf(c.spec)
				const own = succeeded(parseValue(door, c.value), "the host door reads a value of the type")
				assert.ok(
					sameValue(oneForm(hostForm(own)), oneForm(c.value)),
					"the host door reads the value, its one form unchanged"
				)
				const back = succeeded(
					parseScalar(c.spec, encodeScalar(c.spec, c.value)),
					"the wire reads its JSON"
				)
				assert.ok(
					sameValue(back, oneForm(hostForm(own))),
					"the wire reads back the one form of the value the host door reads"
				)
				const parsed = parseScalar(c.spec, c.near)
				if (!parsed.ok) {
					return
				}
				const host = succeeded(
					parseValue(door, parsed.value),
					`the host door reads what the wire read of ${Formatter.format(c.near)}`
				)
				assert.ok(
					sameValue(oneForm(hostForm(host)), parsed.value),
					"the host door reads it, its one form unchanged"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "scalar/values/identity.ts parseValue, the one door for every caller's host value"
		},
		budget: { runs: 2000, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/live/wire.test.ts#theWiresOneTableParsesToExactlyWhatTheHostDoorParsesEveryValueItReadsTheHostDoorReadsUnchangedAndEveryValueOfATypeReadsBackFromItsJSON:-:h.2.1.0.1.1.1.0.0.0"
				),
				reason:
					"a vector holding a -0 component, which the wire reads back as 0 (wire-host-door, live test phase 729f76a6)",
				since: "2026-11-11"
			}
		],
		kills: [
			{
				file: "packages/engine/src/live/wire.ts",
				original:
					"\tconst units = parts.coefficient * 10n ** BigInt(moneyFractionDigits - parts.minScale)",
				replacement:
					"\tconst units = parts.coefficient * 10n ** BigInt(parts.minScale - moneyFractionDigits)",
				why: "Operator mutant (operand-swap) at packages/engine/src/live/wire.ts:450 in minorUnitsOf: `moneyFractionDigits.value - parts.minScale` becomes `parts.minScale - moneyFractionDigits.value`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
