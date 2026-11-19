import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
/**
 * Relation inputs: the host codec owns the set property and the null ban, deduplicating by fact identity after native
 * coercion and encoding canonically as one array literal per column. The host collects a Stream member whole before it
 * normalizes it (adapter/reader/params.ts). Deduplication and PostgreSQL's reading of the arrays are the pg relation
 * suite's, against PostgreSQL's own DISTINCT and array_in on generated cases (test/pg/codec/relation.test.ts); here,
 * the refusals, the canonical encoding and the literals' grammar, read back by array_in's rules (test/support/arrays.ts).
 *
 * - Refusals: a member planted among valid ones is refused as an EncodingFailure naming the slot and the field, never
 *   the value; a span member is admitted exactly at its column's fixed width.
 * - Canonical encoding: one set in any order, repeated or spelled otherwise (an id's case, a numeric's display scale),
 *   gives byte-identical arrays, and the host's normalized facts write the raw input's arrays in any column order.
 *   Oracle: the encoding of the set as first given, a differential. A valid fact's fields are values their types hold
 *   as they are (a numeric(5,2) value is a count of hundredths), which the input boundary admits.
 * - Literals: each column's array literal reads back by array_in's rules as the column's texts, whatever they hold, the
 *   longest literal refused past the string bound and written within it, and every type's canonical text carried.
 *   Oracle: array_in's grammar restated (test/support/arrays.ts readArrayLiteral), a second implementation.
 *
 * Features: each planted refusal; a fixed and another width; an empty set and a set of several facts; each fact spelled
 * once and a fact spelled again; a column of no row, and a row of an empty cell; the bound far within, at, one past and
 * far past.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import {
	arrayTexts,
	normalFacts,
	parameterNormalizer,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { EncodingFailure } from "#compiler/core/errors.ts"
import type { FactIdentity } from "#compiler/scalar/values/identity.ts"
import { arraysEncoder, readArrayLiteral } from "#test/support/arrays.ts"
import { assert, defined, failed, succeeded } from "#test/support/assert.ts"
import { paramText, textOfParam } from "#test/support/wire.ts"
import {
	boundCases,
	encodeNeed,
	everyFacts,
	everySpec,
	everyType,
	fieldsOfReading,
	literalCases,
	type LiteralFeature,
	normalizeNeed,
	orderedSets,
	type Plant,
	plantSituations,
	readingHeading,
	refusalCases,
	scaledSpec,
	slotSpec,
	spanCases,
	spelledReadings,
	spelledSets,
	statements
} from "#test/unit/codec/recordset.fixtures.ts"
import { kindCodes, normalizedBy } from "#test/unit/codec/support.ts"
import { asDecimal } from "#test/unit/codec/values.ts"

/**
 * Relation normalization refuses a planted member with its word, naming the slot and the field, never the value.
 *
 * Budget: its suite's count before the conversion (unit/codec/recordset-refusals: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const relationNormalizationRefusesAPlantedMemberWithItsWordNamingTheSlotAndTheFieldNeverTheValue =
	property.explore(refusalCases, {
		needs: { normalizeNeed },
		situations: plantSituations,
		check:
			({ normalizeNeed }, c: Case<`plant ${Plant}`>) =>
			({ facts, at, plant, field, bad }) =>
				Effect.gen(function* () {
					const normalize = yield* normalizeNeed
					return yield* Effect.sync(() => {
						c.note(`plant ${plant}`)
						const [member, reason, slot]: readonly [
							unknown,
							EncodingFailure["reason"]["_tag"],
							string | undefined
						] = (() => {
							switch (plant) {
								case "null member":
									return [null, "nullValue", "readings"]
								case "null field":
									return [{ ...bad, [field]: null }, "nullValue", `readings.${field}`]
								case "undefined field":
									return [{ ...bad, [field]: undefined }, "nullValue", `readings.${field}`]
								case "missing field": {
									const { [field]: _, ...rest } = bad
									return [rest, "factShape", undefined]
								}
								case "extra field":
									return [{ ...bad, extra: 1 }, "factShape", undefined]
								case "number for decimal":
									return [{ ...bad, value: 1.5 }, "decimalNumber", "readings.value"]
							}
						})()
						const members = [
							...facts.slice(0, at % (facts.length + 1)),
							member,
							...facts.slice(at % (facts.length + 1))
						]
						const result = normalizedBy(normalize, members)
						const failure = !result.ok ? result.error : result.value
						assert.ok(failure instanceof EncodingFailure, plant)
						assert.equal(failure.reason._tag, reason, plant)
						if (slot !== undefined) {
							assert.deepEqual(failure.place, { _tag: "Slot", name: slot }, plant)
						}
					})
				}),
		oracle: {
			kind: "specification",
			name: "README's Errors and outcomes: the slot and the field named, never the value"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tconst units = exactUnits(d, typmod.scale)",
				replacement: "\tconst units = exactUnits(d, typmod.scale - 1)",
				why: "parseNumeric judges exactness at the scale less one, so a numeric(5,2) value of exactly two fractional digits is refused as numericScale; the refusal, canonical encoding and array properties fail on a valid fact."
			}
		]
	})

/**
 * Relation normalization admits a member span of its column's fixed width, and refuses any other width.
 *
 * Budget: its suite's count before the conversion (unit/codec/recordset-fixed-width: 300 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const relationNormalizationAdmitsAMemberSpanOfItsColumnsFixedWidthAndRefusesAnyOtherWidth =
	property.explore(spanCases, {
		needs: {},
		situations: ["fixed width", "other width"] satisfies ReadonlyArray<
			Reached<"fixed width" | "other width">
		>,
		check:
			(_, c: Case<"fixed width" | "other width">) =>
			({ start, width }) =>
				Effect.gen(function* () {
					const normalize = parameterNormalizer(slotSpec)
					return yield* Effect.sync(() => {
						const result = normalize([{ fixed: { start, end: start + width } }])
						if (width === 15) {
							c.note("fixed width")
							assert.deepEqual(succeeded(result).rows, [[paramText(`[${start},${start + 15})`)]])
						} else {
							c.note("other width")
							assert.deepEqual(
								result,
								Result.err(
									EncodingFailure.make({
										reason: { _tag: "spanWidth" },
										place: { _tag: "Slot", name: "slots.fixed" }
									})
								)
							)
						}
					})
				}),
		oracle: { kind: "specification", name: "a span column's fixed width" },
		budget: { runs: 300, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/codec/recordset.test.ts#relationNormalizationAdmitsAMemberSpanOfItsColumnsFixedWidthAndRefusesAnyOtherWidth:-:e.e"
				),
				reason: "a span of the fixed width",
				since: "2026-10-29"
			}
		],
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
 * Relation normalization encodes canonically: the same set in any order gives byte-identical arrays.
 *
 * Budget: its suite's count before the conversion (unit/codec/recordset-1919247219: 500 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const relationNormalizationEncodesCanonicallyTheSameSetInAnyOrderGivesByteIdenticalArrays =
	property.explore(orderedSets, {
		needs: { encodeNeed },
		situations: ["an empty set", "a set of several facts"] satisfies ReadonlyArray<
			Reached<"an empty set" | "a set of several facts">
		>,
		check:
			({ encodeNeed }, c: Case<"an empty set" | "a set of several facts">) =>
			([facts, seed]) =>
				Effect.gen(function* () {
					const encode = yield* encodeNeed
					return yield* Effect.sync(() => {
						c.note(facts.length === 0 ? "an empty set" : "a set of several facts")
						/** A code unit past the end reads as 0, as the native NaN does under `^`. */
						const rank = (id: string): number =>
							Option.getOrElse(Str.charCodeAt(id, seed % 36), () => 0) ^ seed
						const shuffled = Arr.sort(
							facts,
							Order.mapInput(Order.Number, (fact: { readonly id: string }) => rank(fact.id))
						)
						const first = succeeded(encode(facts))
						const second = succeeded(encode([...shuffled, ...shuffled]))
						assert.deepEqual(second, first)
						assert.equal(first.count, facts.length)
						assert.equal(first.arrays.length, fieldsOfReading.length)
						for (const array of first.arrays) {
							assert.equal(readArrayLiteral(array).length, facts.length)
						}
					})
				}),
		oracle: {
			kind: "universal",
			name: "the encoding of the set as first given, against any order and repetition"
		},
		budget: { runs: 500, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/recordset.ts",
				original:
					"\tsortInPlace(entries, (a, b) => compareFactIdentities(a.identity, b.identity))\n",
				replacement: "",
				why: "A set is encoded in the order given, not its canonical order; the canonical encoding property fails."
			},
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tconst units = exactUnits(d, typmod.scale)",
				replacement: "\tconst units = exactUnits(d, typmod.scale - 1)",
				why: "parseNumeric judges exactness at the scale less one, so a numeric(5,2) value of exactly two fractional digits is refused as numericScale; the refusal, canonical encoding and array properties fail on a valid fact."
			}
		]
	})

/**
 * Relation normalization writes each array of facts normalized on the host as the raw input's arrays, in the heading's
 * order or another.
 *
 * Budget: its suite's count before the conversion (unit/codec/recordset-1852797549: 300 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const relationNormalizationWritesEachArrayOfFactsNormalizedOnTheHostAsTheRawInputsArraysInTheHeadingsOrderOrAnother =
	property.explore(spelledReadings, {
		needs: {},
		situations: ["an empty set", "a set of several facts"] satisfies ReadonlyArray<
			Reached<"an empty set" | "a set of several facts">
		>,
		check: (_, c: Case<"an empty set" | "a set of several facts">) => (facts) =>
			Effect.gen(function* () {
				const normalize = relationNormalizer(readingHeading)
				return yield* Effect.sync(() => {
					c.note(facts.length === 0 ? "an empty set" : "a set of several facts")
					const normal = succeeded(normalizedBy(normalize, facts))
					const byIdentity = new TupleMap<
						FactIdentity,
						{ readonly fact: { readonly [field: string]: unknown } }
					>()
					for (const e of normal.entries) {
						byIdentity.set(e.identity, { fact: e.fact })
					}
					const marked = normalFacts(byIdentity)
					for (const { encode, write } of statements) {
						const arrays = succeeded(encode(facts)).arrays
						assert.deepEqual<ReadonlyArray<string>>(
							Arr.map(arrays, (_, part) => textOfParam(succeeded(write(marked, part)))),
							arrays
						)
					}
				})
			}),
		oracle: {
			kind: "universal",
			name: "the raw input's arrays, against the host's normalized facts in any column order"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tconst units = exactUnits(d, typmod.scale)",
				replacement: "\tconst units = exactUnits(d, typmod.scale - 1)",
				why: "parseNumeric judges exactness at the scale less one, so a numeric(5,2) value of exactly two fractional digits is refused as numericScale; the refusal, canonical encoding and array properties fail on a valid fact."
			}
		]
	})

/**
 * Relation normalization encodes canonically whatever input spelling equal facts' numerics of no typmod took.
 *
 * Budget: its suite's count before the conversion (unit/codec/recordset-1935892844: 500 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const relationNormalizationEncodesCanonicallyWhateverInputSpellingEqualFactsNumericsOfNoTypmodTook =
	property.explore(spelledSets, {
		needs: {},
		situations: ["each fact spelled once", "a fact spelled again"] satisfies ReadonlyArray<
			Reached<"each fact spelled once" | "a fact spelled again">
		>,
		check:
			(_, c: Case<"each fact spelled once" | "a fact spelled again">) =>
			([{ facts, extra }, seed]) =>
				Effect.gen(function* () {
					const encode = arraysEncoder(scaledSpec)
					const normalize = parameterNormalizer(scaledSpec)
					return yield* Effect.sync(() => {
						c.note(extra.length === 0 ? "each fact spelled once" : "a fact spelled again")
						const all = [...facts, ...extra]
						const shuffled = Arr.map(
							Arr.sort(
								Arr.map(all, (fact, i) => ({ fact, r: (i * 2654435761 + seed) % 4294967296 })),
								Order.mapInput(Order.Number, (x: { readonly r: number }) => x.r)
							),
							(x) => x.fact
						)
						const first = succeeded(encode(all))
						const second = succeeded(encode(Arr.reverse([...shuffled])))
						assert.deepEqual(second.arrays, first.arrays)
						assert.equal(first.count, facts.length)
						const a = succeeded(normalize(all))
						const b = succeeded(normalize(shuffled))
						assert.deepEqual(b.rows, a.rows)
						assert.deepEqual(
							Arr.map(b.facts, (f) => asDecimal(f["n"]).toString()),
							Arr.map(a.facts, (f) => asDecimal(f["n"]).toString())
						)
					})
				}),
		oracle: {
			kind: "universal",
			name: "the encoding of the set as first spelled, against every other spelling"
		},
		budget: { runs: 500, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tif (end === digitsStart) {",
				replacement: "\tif (end !== digitsStart) {",
				why: "Operator mutant (comparison) at packages/engine/src/scalar/values/decimal.ts:73 in exponentAt: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Relation normalization writes one array literal per column that array_in reads back as the column's texts, whatever
 * they hold.
 *
 * Budget: its suite's count before the conversion (unit/codec/arrays-literal: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const relationNormalizationWritesOneArrayLiteralPerColumnThatArrayInReadsBackAsTheColumnsTextsWhateverTheyHold =
	property.explore(literalCases, {
		needs: {},
		situations: [
			"a column of no row",
			"an empty cell",
			"a cell of array syntax"
		] satisfies ReadonlyArray<
			Reached<"a column of no row" | "an empty cell" | "a cell of array syntax">
		>,
		check:
			(_, c: Case<"a column of no row" | "an empty cell" | "a cell of array syntax">) =>
			([width, rows]) =>
				Effect.sync(() => {
					if (width > 0 && rows.length === 0) {
						c.note("a column of no row")
					}
					for (const cell of Arr.flatten(rows)) {
						if (cell === "") {
							c.note("an empty cell")
						}
						if (Arr.some(['"', "\\", ",", "{", "}"], (syntax) => Str.includes(syntax)(cell))) {
							c.note("a cell of array syntax")
						}
					}
					const columns = Array.from({ length: width }, (_, i) => `f${i}`)
					const params = Arr.map(rows, (row) => Arr.map(row, paramText))
					const written = succeeded(arrayTexts("Input", columns, params, 2 ** 20))
					if (width === 0) {
						assert.deepEqual(written, [paramText(String(rows.length))])
						return
					}
					assert.equal(written.length, width)
					for (const [j, literal] of written.entries()) {
						assert.deepEqual(
							readArrayLiteral(literal),
							Arr.map(rows, (row) => defined(row[j])),
							`column ${j} of ${literal}`
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "array_in's grammar restated (readArrayLiteral)"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/recordset.ts",
				original: `\toverhead === 2 ? \`"\${text}"\` : \`"\${text.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\\\"')}"\``,
				replacement: `\toverhead === 2 ? \`"\${text}"\` : \`"\${text.replaceAll("\\\\", "\\\\\\\\")}"\``,
				why: "A quote inside an array element is written bare; the literals' array_in reading fails."
			}
		]
	})

/**
 * Relation normalization refuses a column whose literal would pass the string bound, naming it, and writes every
 * literal within it.
 *
 * Budget: its suite's count before the conversion (unit/codec/arrays-literal-bound: 300 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const relationNormalizationRefusesAColumnWhoseLiteralWouldPassTheStringBoundNamingItAndWritesEveryLiteralWithinIt =
	property.explore(boundCases, {
		needs: {},
		situations: [
			"far within the bound",
			"at the bound",
			"one past the bound",
			"far past the bound"
		] satisfies ReadonlyArray<Reached<LiteralFeature>>,
		check:
			(_, c: Case<LiteralFeature>) =>
			({ width, rows, by }) =>
				Effect.sync(() => {
					const columns = Array.from({ length: width }, (_, i) => `f${i}`)
					const params = Arr.map(rows, (row) => Arr.map(row, paramText))
					const whole = succeeded(arrayTexts("Input", columns, params, 2 ** 20))
					const longest = Arr.reduce(whole, 0, (n, literal) => Math.max(n, literal.length))
					const limit = Math.max(longest + by, 0)
					c.note(
						limit === longest
							? "at the bound"
							: limit === longest - 1
								? "one past the bound"
								: limit > longest
									? "far within the bound"
									: "far past the bound"
					)
					const bounded = arrayTexts("Input", columns, params, limit)
					if (longest <= limit) {
						assert.deepEqual(succeeded(bounded), whole)
						return
					}
					const bound = failed(bounded)
					assert.deepEqual(
						{ _tag: bound._tag, input: bound.input, limit: bound.limit },
						{ _tag: "LiteralBound", input: "Input", limit }
					)
					const at = Arr.findFirstIndex(columns, (column) => column === bound.column)
					assert.ok(Option.isSome(at), `the refusal names a column: ${bound.column}`)
					assert.ok(
						defined(whole[at.value]).length > limit,
						`${bound.column}'s literal passes the bound`
					)
				}),
		oracle: {
			kind: "specification",
			name: "each column's literal written with no bound, against the bound: refused exactly when one is longer, naming one that is"
		},
		budget: { runs: 300, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/codec/recordset.test.ts#relationNormalizationRefusesAColumnWhoseLiteralWouldPassTheStringBoundNamingItAndWritesEveryLiteralWithinIt:-:0.0.5"
				),
				reason:
					"a column's literal of no row, its braces alone, was written past a bound one short of it",
				since: "2026-11-07"
			}
		],
		kills: [
			{
				file: "packages/engine/src/codec/recordset.ts",
				original:
					'\tfor (let at = text.indexOf("\\\\"); at >= 0; at = text.indexOf("\\\\", at + 1)) {\n\t\tadded += 1\n\t}',
				replacement:
					'\tfor (let at = text.indexOf("\\\\"); at >= 0; at = text.indexOf("\\\\", at + 1)) {\n\t\tadded += 2\n\t}',
				why: "Operator mutant (bound) at packages/engine/src/codec/recordset.ts:401 in elementOverhead: `1` becomes `2`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The arrays of every field type carry each value's canonical text, which array_in reads back exactly, in the facts'
 * canonical order.
 *
 * Budget: its suite's count before the conversion (unit/codec/arrays-every-type: 200 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theArraysOfEveryFieldTypeCarryEachValuesCanonicalTextWhichArrayInReadsBackExactlyInTheFactsCanonicalOrder =
	property.explore(everyFacts, {
		needs: {},
		situations: ["an empty set", "a set of several facts"] satisfies ReadonlyArray<
			Reached<"an empty set" | "a set of several facts">
		>,
		check: (_, c: Case<"an empty set" | "a set of several facts">) => (facts) =>
			Effect.gen(function* () {
				const encode = arraysEncoder(everySpec)
				const normalize = relationNormalizer(everySpec)
				return yield* Effect.sync(() => {
					c.note(facts.length === 0 ? "an empty set" : "a set of several facts")
					const normal = succeeded(normalizedBy(normalize, facts))
					const { arrays, count } = succeeded(encode(facts))
					assert.equal(count, normal.count)
					assert.equal(arrays.length, everyType.length)
					for (const [j, column] of everyType.entries()) {
						const codec = scalarCodec(column.type, kindCodes)
						assert.deepEqual(
							readArrayLiteral(defined(arrays[j])),
							Arr.map(normal.facts, (fact) => codec.text(fact[column.name])),
							`the ${column.name} column`
						)
					}
				})
			}),
		oracle: {
			kind: "second-implementation",
			name: "array_in's grammar restated, and each value's canonical text"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tconst units = exactUnits(d, typmod.scale)",
				replacement: "\tconst units = exactUnits(d, typmod.scale - 1)",
				why: "parseNumeric judges exactness at the scale less one, so a numeric(5,2) value of exactly two fractional digits is refused as numericScale; the refusal, canonical encoding and array properties fail on a valid fact."
			}
		]
	})
