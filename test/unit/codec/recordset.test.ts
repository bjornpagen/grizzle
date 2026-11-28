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
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
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
import { TextsMap } from "#compiler/core/text.ts"
import type { IdentifiedFact } from "#compiler/ir/products.ts"
import { arraysEncoder, readArrayLiteral } from "#test/support/arrays.ts"
import { failed, succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { kindCodes, normalizedBy } from "#test/support/unit/codec/support.ts"
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
	notesHeading,
	orderedSets,
	type PlantFeature,
	plantedMembers,
	plantedValue,
	plantFeatures,
	plantFeaturesOf,
	readingHeading,
	ruleOf,
	scaledSpec,
	slotSpec,
	spanCases,
	spelledReadings,
	spelledSets,
	otherReading,
	pastTheBound,
	pastTheBoundBox,
	statements
} from "#test/unit/codec/recordset.fixtures.ts"
import { asDecimal } from "#test/unit/codec/values.ts"

/**
 * A relation input's member is refused by the first fault of its one read, by one rule (scalar/values/identity.ts
 * readFact), whatever other faults it holds: the member as a whole first, NULL or undefined (nullValue), then anything
 * but a plain record of its heading's count of own keys (factShape); then each field in name order, a field it lacks
 * or whose getter throws (factShape), NULL or undefined (nullValue), or a value its carrier refuses (that carrier's
 * fault, as the field's one admission gives it, admitValue); the refusal names the slot and the field, never the value.
 * And each field is read once, exactly where the read reaches it: a getter runs once, or never where the read stops
 * before its field. The box: every way a member is planted as a whole, crossed with every way each of its three fields
 * is planted, the member alone or after a valid one.
 */
export const aRelationInputsMemberIsRefusedByTheFirstFaultOfItsOneReadByOneRuleEachFieldReadOnce =
	property.exhaust(finite(plantedMembers), {
		box: "a member planted as a whole (a fact, NULL, undefined, a number, an array, a record of another prototype, a fact with a key past its heading's) crossed with each of its three fields planted (its value, its value through a getter, no such field, NULL, undefined, a value its carrier refuses, a getter that throws), alone or after a valid member",
		needs: { normalizeNeed },
		situations: plantFeatures satisfies ReadonlyArray<Reached<PlantFeature>>,
		check:
			({ normalizeNeed }, c: Case<PlantFeature>) =>
			(plant) =>
				Effect.gen(function* () {
					const normalize = yield* normalizeNeed
					return yield* Effect.sync(() => {
						const { member, reads } = plantedValue(plant)
						const { refusal, reached } = ruleOf(plant)
						const result = normalizedBy(
							normalize,
							plant.after === "alone" ? [member] : [otherReading, member]
						)
						for (const field of fieldsOfReading) {
							const getter =
								plant.fields[field] === "its value through a getter" ||
								plant.fields[field] === "a getter that throws"
							assert.equal(
								reads[field],
								getter && reached.has(field) ? 1 : 0,
								`${field}'s getter runs once where the read reaches it, never where it stops before`
							)
						}
						for (const feature of plantFeaturesOf(plant, refusal, reached)) {
							c.note(feature)
						}
						if (refusal === undefined) {
							assert.equal(
								succeeded(result).count,
								plant.after === "alone" ? 1 : 2,
								"a member of no fault is admitted"
							)
							return
						}
						const failure = failed(result)
						assert.deepEqual(
							[failure.reason._tag, failure.place],
							[
								refusal.fault,
								{
									_tag: "Slot",
									name: refusal.field === undefined ? "readings" : `readings.${refusal.field}`
								}
							],
							"the rule's first fault, at the slot and its field"
						)
					})
				}),
		oracle: {
			kind: "specification",
			name: "the rule of refusal: the member whole, then each field by name, the first fault of one read, each field read once"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/recordset.ts",
				original:
					"\tconst readRow = (fact: unknown): Result.Result<ReadFact, RowRefusal> => readFact(s.plan, fact)",
				replacement:
					'\tconst readRow = (fact: unknown): Result.Result<ReadFact, RowRefusal> => { if (fact === null || fact === undefined) { return Result.err({ fault: "nullValue", field: undefined }) } if (typeof fact === "object") { for (const column of columns) { if (Object.hasOwn(fact, column.field)) { const value = fact[column.field]; if (value === null || value === undefined) { return Result.err({ fault: "nullValue", field: column.field }) } } } } return readFact(s.plan, fact) }',
				why: "The null ban reads every field the member holds before readFact reads it again, as it did before PERFWRITE: a getter runs twice, and runs on a record of another prototype the read refuses whole; a NULL is refused over the member's shape and over an earlier field's fault, and of two NULLs the first in heading order, not by name."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original:
					'\tvalue === null || value === undefined\n\t\t? Result.err("nullValue")\n\t\t: spec.carrier !== "bytes"',
				replacement: '\tspec.carrier !== "bytes"',
				why: "No admission holds the null ban: a NULL field reaches its carrier's parse and is refused by the carrier's type fault, not nullValue."
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
					"\tconst entries = inIdentityOrder(Array.from(byIdentity.values()), (e) => e.identity)",
				replacement: "\tconst entries = Array.from(byIdentity.values())",
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
					const byIdentity = new TextsMap<IdentifiedFact>()
					for (const e of normal.entries) {
						byIdentity.set(e.identity, e)
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
					"test/unit/codec/recordset.test.ts#relationNormalizationRefusesAColumnWhoseLiteralWouldPassTheStringBoundNamingItAndWritesEveryLiteralWithinIt:-:0.0.2"
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

/**
 * A relation input of facts whose texts spell past the longest string V8 holds is normalized, never throwing: over a
 * box of notes holding one text whose JSON literal passes the bound (`pastTheBound`, U+0001 over and over) in one field
 * or in both, beside a note of short texts, each stated once or twice, normalization admits each distinct note once,
 * in canonical order, the short note before the long one whose first field it begins, since a fact's identity holds its
 * texts and their digest and never one string of them (core/text.ts TextsId). Before IDKEY the identity was the texts'
 * JSON array as one string, and JSON.stringify threw RangeError past the bound.
 */
export const aRelationInputOfFactsPastTheLongestStringIsNormalizedNeverThrowing = property.exhaust(
	pastTheBoundBox,
	{
		box: "a note holding the text past the bound in its first field or in both, beside a short note, each stated once or twice",
		needs: {},
		situations: [],
		check: () => (box) =>
			Effect.sync(() => {
				const long = {
					a: pastTheBound,
					b: box.fields === "both" ? pastTheBound : "b"
				}
				const short = { a: "\u0001", b: "b" }
				const facts = Array.from({ length: box.copies }, () => [long, short]).flat()
				const normal = succeeded(normalizedBy(relationNormalizer(notesHeading), facts))
				assert.equal(normal.count, 2, "each distinct note once")
				assert.deepEqual(
					Arr.map(normal.facts, (fact) => fact["b"] === pastTheBound || fact["a"] === pastTheBound),
					[false, true],
					"the short note first, its first field the long one's prefix"
				)
			}),
		oracle: {
			kind: "specification",
			name: "a fact's identity of any size: its texts and their digest, never one string of them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\treturn { fact: Object.freeze(kept), texts, identity: textsId(texts) }",
				replacement:
					"\treturn { fact: Object.freeze(kept), texts, identity: textsId([JSON.stringify(texts)]) }",
				why: "A fact's identity is its texts' JSON array as one string, as before IDKEY: past the longest string JSON.stringify throws RangeError, out of the write."
			}
		]
	}
)

/** The calls a fact identity is counted by (core/text.ts textsId). */
const keySites = Object.freeze({
	keys: { file: "packages/engine/src/core/text.ts", name: "textsId" }
})

/**
 * A relation input's normalization keys each fact once and sorts the keys as they are: over sets of up to twenty
 * readings of distinct ids, normalizing them (read, then admitted: kept apart by identity and put in canonical order)
 * calls textsId once for each fact, read off V8's call counts (kernel/calls.ts callCounts), so its sort and its
 * deduplication compare and hash each identity's key as it was made, quoting no text again.
 */
export const relationNormalizationKeysEachFactOnceAndSortsTheKeysAsTheyAre = property.explore(
	orderedSets,
	{
		needs: {},
		budget: { runs: 12, steered: 0 },
		situations: [],
		check: () => (set) =>
			Effect.gen(function* () {
				const [readings] = set
				const normalize = relationNormalizer(readingHeading)
				const [normal, counts] = yield* callCounts(
					Effect.sync(() => succeeded(normalizedBy(normalize, readings))),
					keySites
				)
				assert.equal(normal.count, readings.length, "readings of distinct ids, each kept")
				assert.equal(counts.keys, readings.length, "each fact keyed once")
			}),
		oracle: { kind: "specification", name: "one key per fact, made once" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/recordset.ts",
				original:
					"\tconst entries = inIdentityOrder(Array.from(byIdentity.values()), (e) => e.identity)",
				replacement:
					"\tconst entries = inIdentityOrder(Array.from(byIdentity.values()), (e) => textsId(e.identity.texts))",
				why: "The sort keys each fact again, so a set of n facts is keyed 2n times past its n."
			}
		]
	}
)
