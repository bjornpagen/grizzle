import { inspect } from "node:util"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { drawnFeature, passed } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, pipe, Record, String as Str } from "effect"
import { scalarReader } from "#compiler/codec/read.ts"
import { tupleConverter } from "#compiler/codec/row.ts"
import { carrierSpecOf, paramEncoder, scalarCodec } from "#compiler/codec/scalar.ts"
import { int4Max } from "#compiler/core/canonical.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import { digestOf } from "#compiler/scalar/values/bytes.ts"
import { factIdentity, parseValue } from "#compiler/scalar/values/identity.ts"
import { kindCodes } from "#test/support/unit/codec/support.ts"
import {
	caseGen,
	decoded,
	type EncoderFeature,
	encoderSituations,
	factGen,
	heading,
	isCodecFault,
	marker,
	type RowCell,
	rowCaseGen,
	slotCases,
	unstableCases,
	unstableSpan,
	wildAims,
	written
} from "#test/support/unit/codec/wild.fixtures.ts"
import { echoed, outputText, paramText } from "#test/support/wire.ts"

/**
 * The encoders refuse every value with a word of the vocabulary, or admit it to a text that round-trips, and never
 * throw.
 *
 * Budget: its suite's count before the conversion (unit/codec/wild: 3000 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theEncodersRefuseEveryValueWithAWordOfTheVocabularyOrAdmitItToATextThatRoundTripsAndNeverThrow =
	property.explore(aimed(caseGen, wildAims), {
		needs: {},
		situations: encoderSituations,
		check:
			(_, c: Case<EncoderFeature>) =>
			([target, drawn]) =>
				Effect.sync(() => {
					const codec = scalarCodec(target.type, kindCodes)
					const value = passed(drawn)
					c.note(drawn.kind === "stale" ? "stale" : drawnFeature(drawn))
					const encoded = codec.encode(value)
					if (!encoded.ok) {
						c.note("refused")
						assert.ok(isCodecFault(encoded.error), `${target.label}: refused with ${encoded.error}`)
						assert.notEqual(
							drawn.kind,
							"live",
							`${target.label}: a Live value was refused (${encoded.error})`
						)
						const slotted = paramEncoder(target.type, "slot", kindCodes)(value)
						assert.ok(
							!slotted.ok,
							`${target.label}: the slot's encoder admitted what the codec refused`
						)
						assert.equal(slotted.error.reason._tag, encoded.error)
						return
					}
					if (drawn.kind === "stale") {
						c.note("admitted from another carrier")
					}
					const again = codec.encode(
						scalarReader(target.type, kindCodes).convert(echoed(target.type, encoded.value))
					)
					assert.deepEqual(
						again,
						Result.ok(encoded.value),
						`${target.label}: the converted value encodes otherwise`
					)
				}),
		oracle: {
			kind: "universal",
			name: "a word of the codec's vocabulary, or a text that converts back and encodes to itself"
		},
		budget: { runs: 3000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: '\tif (spec.carrier === "bytes") {',
				replacement: '\tif (spec.carrier !== "bytes") {',
				why: "Operator mutant (comparison) at packages/engine/src/codec/scalar.ts:124 in parameterText: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The encoders name the slot and the word in a template slot's refusal, never the value.
 *
 * Budget: its suite's count before the conversion (unit/codec/wild-slot: 500 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theEncodersNameTheSlotAndTheWordInATemplateSlotsRefusalNeverTheValue =
	property.explore(slotCases, {
		needs: {},
		situations: [],
		check:
			() =>
			([target, text]) =>
				Effect.sync(() => {
					const encoded = paramEncoder(
						target.type,
						"slot",
						kindCodes
					)(target.type.carrier === "text" ? `${text}\u0000` : text)
					if (encoded.ok) {
						return
					}
					assert.deepEqual(encoded.error.place, { _tag: "Slot", name: "slot" })
					assert.ok(
						!pipe(inspect(encoded.error, { depth: 8 }), Str.includes(marker)),
						`${target.label}: the refusal holds the value`
					)
				}),
		oracle: {
			kind: "specification",
			name: "the slot and the word named, the value's marker absent"
		},
		budget: { runs: 500, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/subset.ts",
				original:
					'subset.kind === "done" ||\n\t\t\tthis.#configs\n\t\t\t\t.closure(subset.configs, { atStart: subset.initial, atEnd: true })\n\t\t\t\t.some((c) => this.#configs.state(c) === this.nfa.accept)',
				replacement: 'subset.kind === "done"',
				why: "Census mutant 5e0a3b3402 (packages/text/src/regex/subset.ts, SearchSubsets acceptsAtEnd), restated on the counting automaton's configurations: a text accepts only once a match was found before its end, never at its end; the property fails (the census, lane TESTPOLICY2; restated by lane TEXTSPEC)."
			}
		]
	})

/**
 * Admission reads a value once admits a getter's first answer and encodes from it, however it answers after.
 *
 * Budget: its suite's count before the conversion (unit/codec/wild-unstable: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const admissionReadsAValueOnceAdmitsAGettersFirstAnswerAndEncodesFromItHoweverItAnswersAfter =
	property.explore(unstableCases, {
		needs: {},
		situations: [],
		check:
			() =>
			([first, then]) =>
				Effect.sync(() => {
					const end = int4Max
					const range4 = decoded(written.range4[0]).type
					const codec = scalarCodec(range4, kindCodes)
					const unstable = unstableSpan(first, then, end)
					const encoded = codec.encode(unstable.span)
					assert.deepEqual(encoded, Result.ok(paramText(`[${first},${end})`)))
					assert.equal(unstable.reads(), 1, "the getter is read once")
					/** A fact's field: read once, and its admitted value is the first answer. */
					const heading = [{ name: "span", spec: carrierSpecOf(range4, kindCodes) }]
					const fieldReads = unstableSpan(first, then, end)
					let factReads = 0
					const fact = Object.defineProperty({}, "span", {
						enumerable: true,
						get: () => {
							factReads++
							return factReads === 1 ? fieldReads.span : undefined
						}
					})
					const admitted = factIdentity(heading, fact)
					assert.ok(admitted.ok)
					assert.equal(factReads, 1, "the fact's field is read once")
					assert.deepEqual(admitted.value.fact["span"], { start: first, end })
				}),
		oracle: {
			kind: "specification",
			name: "the getter's first answer, as admission kept it"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original:
					"\tconst repeat = firstIndex(fields, (f, i) => i > 0 && fields[i - 1]?.name === f.name)",
				replacement: "\tconst repeat = firstIndex(fields, (f, i) => true)",
				why: "Operator mutant (boolean-return) at packages/engine/src/scalar/values/identity.ts:536 in headingPlan: `i > 0 && fields[i - 1]?.name === f.name` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Fact identity refuses every fact with a word and its field, or admits every field, and never throws.
 *
 * Budget: its suite's count before the conversion (unit/codec/wild-fact: 1000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const factIdentityRefusesEveryFactWithAWordAndItsFieldOrAdmitsEveryFieldAndNeverThrows =
	property.explore(factGen, {
		needs: {},
		situations: ["admitted", "refused at a field", "refused whole"] satisfies ReadonlyArray<
			Reached<"admitted" | "refused at a field" | "refused whole">
		>,
		check: (_, c: Case<"admitted" | "refused at a field" | "refused whole">) => (drawn) =>
			Effect.sync(() => {
				const fact =
					drawn.kind === "fields"
						? Record.fromEntries(Arr.map(drawn.fields, (field, i) => [`f${i}`, passed(field)]))
						: passed({ kind: "wild", wild: drawn.wild })
				const admitted = factIdentity(heading, fact)
				if (admitted.ok) {
					c.note("admitted")
					return
				}
				assert.ok(isCodecFault(admitted.error.fault), `refused with ${admitted.error.fault}`)
				c.note(admitted.error.field === undefined ? "refused whole" : "refused at a field")
				if (drawn.kind === "fields" && Arr.every(drawn.fields, (f) => f.kind === "live")) {
					assert.fail(
						`a fact of Live fields was refused: ${admitted.error.fault} at ${String(admitted.error.field)}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a word and the field it refuses, or every field admitted"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/span.ts",
				original: '\t\tif (typeof value !== "bigint" || value < int8Min || value > int8Max) {',
				replacement: '\t\tif (typeof value !== "bigint" || value >= int8Min || value > int8Max) {',
				why: "Operator mutant (comparison) at packages/engine/src/scalar/values/span.ts:51 in the int8 range endpoint: `<` becomes `>=`, so every int8 endpoint at or above the minimum is refused as spanEndpoint; a fact of Live fields is refused and the property fails (lane CATCH, grizzle a673cd7a)."
			}
		]
	})

/**
 * The tuple converter converts every row to a frozen tuple, each position the value its text encodes.
 *
 * Budget: its suite's count before the conversion (unit/codec/wild-rows: 1000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theTupleConverterConvertsEveryRowToAFrozenTupleEachPositionTheValueItsTextEncodes =
	property.explore(rowCaseGen, {
		needs: {},
		situations: ["a bytes column", "a column of text"] satisfies ReadonlyArray<
			Reached<"a bytes column" | "a column of text">
		>,
		check:
			(_, c: Case<"a bytes column" | "a column of text">) =>
			({ columns, values }) =>
				Effect.sync(() => {
					for (const column of columns) {
						c.note(column.type.carrier === "bytes" ? "a bytes column" : "a column of text")
					}
					const cells = Arr.map(columns, (column, i): RowCell => {
						if (column.type.carrier === "bytes") {
							const admitted = parseValue({ carrier: "bytes" }, values[i])
							assert.ok(admitted.ok, `${column.label}: a Live value was refused`)
							return { kind: "bytes", digest: admitted.value.digest }
						}
						const encoded = scalarCodec(column.type, kindCodes).encode(values[i])
						assert.ok(encoded.ok, `${column.label}: a Live value was refused`)
						return { kind: "text", column, text: encoded.value }
					})
					/** Repeated private names convert positionally. */
					const tuple = tupleConverter(
						Arr.map(columns, (c) => ({ name: "c", type: c.type })),
						kindCodes
					)(
						Arr.map(cells, (cell): OutputText =>
							cell.kind === "bytes" ? outputText(cell.digest) : echoed(cell.column.type, cell.text)
						)
					)
					assert.ok(Object.isFrozen(tuple))
					assert.equal(tuple.length, columns.length)
					for (const [i, cell] of cells.entries()) {
						if (cell.kind === "bytes") {
							assert.equal(digestOf(tuple[i]), cell.digest)
						} else {
							assert.deepEqual(
								scalarCodec(cell.column.type, kindCodes).encode(tuple[i]),
								Result.ok(cell.text)
							)
						}
					}
				}),
		oracle: {
			kind: "universal",
			name: "each cell's text encodes the value the tuple holds"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tconst units = exactUnits(d, typmod.scale)",
				replacement: "\tconst units = exactUnits(d, typmod.scale - 1)",
				why: "parseNumeric judges exactness at the scale less one, so a Live numeric of exactly its typmod's scale in fractional digits is refused as numericScale; the encoders' and the tuple converter's properties fail."
			}
		]
	})
