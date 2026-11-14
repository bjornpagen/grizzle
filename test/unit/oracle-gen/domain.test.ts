/**
 * The generators' scalar types, value domains and spelling rule (test/support/oracle/gen/domain.ts): every generated
 * type's value classes hold only values the type stores exactly, one native-equality value per class, its edges
 * included; text carries the metadata its pattern derives and admits every generated text; a key field's type is
 * representable as a key; and a stored value is its class's one value, written in its canonical spelling or one of its
 * twins (gen/domain.ts twinSpellings).
 *
 * A comparison parameter binds as the unrefined base.
 *
 * Oracles: the specification, the engine's own judges of each claim (literalProblem, the key representability check,
 * analyzeText, the numeric bound) and the twin table. The types are exhausted over a box: every generated type,
 * computed numerics included, with and without its edge classes, each key kept as a span or as a scalar. Features:
 * every carrier the claims single out, edge classes, a type that is its own key type, a computed numeric; a canonical
 * and a twin spelling.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): domain-duplicate-class.patch (a type's classes holding one twice)
 * turns the types property red; domain-spelled-other-value.patch (a stored value spelling another class's value) the
 * spelling one.
 */
import { drawn, exhaust, explore } from "@bjornpagen/testing/explore"
import { required, requiredInSpace } from "@bjornpagen/testing/features"
import { boolean, element, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"

import { literalProblem, type TypedLiteral } from "#compiler/ir/expr.ts"
import {
	isRefined,
	type NumericBound,
	numericBoundOf,
	type ScalarType,
	textOf
} from "#compiler/ir/scalar.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import { btreeEntryBytes, btreeMaxItemSize, datumBound } from "#compiler/schema/representability.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	allTypeSpecs,
	compareParamType,
	fieldDescOf,
	keyFieldType,
	literalEqualityKey,
	resolveStored,
	resolveValue,
	scalarOfSpec,
	twinsOf,
	valueClasses
} from "#test/support/oracle/gen/domain.ts"
import { textInfo } from "#test/support/text.ts"

const roster = scalarOfSpec({
	carrier: "code",
	roster: { closed: "K0", handles: ["H0", "H1", "H2"] }
})
/**
 * The computed numerics a generated query's columns are typed at (an operation's or an aggregate's result, with the
 * bound its making proved), over a box of bounds around the raw classes' widths: no, one, two and twenty integer digits,
 * and no, one and two fraction digits.
 */
const computed: ReadonlyArray<ScalarType> = Arr.flatMap([0, 1, 2, 20], (digits) =>
	Arr.map([0, 1, 2], (scale) => numericValue({ digits, scale }))
)

const types: Arr.NonEmptyReadonlyArray<ScalarType> = Arr.appendAll(
	Arr.append(Arr.map(allTypeSpecs, scalarOfSpec), roster),
	computed
)

/**
 * Whether a numeric class lies within a computed numeric's bound: its magnitude below 10^digits and its value a multiple
 * of 10^-scale, a negative digits or scale read exactly (bounds.ts tenTo): the value is its coefficient over 10^minScale,
 * so it is below 10^digits exactly when 10^digits times 10^minScale exceeds the coefficient.
 */
const withinBound = (literal: TypedLiteral, bound: NumericBound): boolean => {
	if (literal.kind !== "numeric" || literal.value.parts.kind !== "finite") {
		return true
	}
	const p = literal.value.parts
	const shift = bound.digits + p.minScale
	const below = shift >= 0 ? p.coefficient < 10n ** BigInt(shift) : p.coefficient === 0n
	const multiple =
		p.minScale <= bound.scale ||
		(p.minScale === 0 && p.coefficient % 10n ** BigInt(-bound.scale) === 0n)
	return below && multiple
}

/**
 * Whether a type passes the key representability check as a one-field key (schema/representability.ts): its datum
 * bounded and its B-tree entry within BTMaxItemSize.
 */
const representableKey = (type: ScalarType): boolean => {
	const bound = datumBound(fieldDescOf(type))
	return (
		bound !== undefined &&
		btreeEntryBytes([{ name: "k", datum: bound, nullable: false }]) <= btreeMaxItemSize.value
	)
}

describe("generated scalar types", () => {
	it.effect(
		"hold only exactly stored values, one native-equality value per class, and declare representable keys",
		(ctx) =>
			Effect.gen(function* () {
				type TypeFeature =
					| ScalarType["carrier"]
					| "edge classes"
					| "a type that is its own key type"
					| "a computed numeric"
				yield* searched(
					ctx,
					exhaust(
						{
							box: "every generated type, computed numerics included, with and without its edge classes, each key kept as a span or as a scalar",
							oracle: {
								kind: "specification",
								name: "the engine's literal check, key representability, text analysis and numeric bound"
							},
							suite: "unit/oracle-gen/domain-types",
							/**
							 * Every type, computed numerics included, with and without its edge classes, each key kept as a span or
							 * as a scalar.
							 */
							generator: (source) =>
								[
									source.draw(element(types)),
									source.draw(boolean),
									source.draw(element<"span" | "scalar">(["span", "scalar"]))
								] as const,
							literal: Formatter.format,
							coverage: requiredInSpace<TypeFeature>([
								"text",
								"numeric",
								"code",
								"range4",
								"vector",
								"edge classes",
								"a type that is its own key type",
								"a computed numeric"
							]),
							caseHang,
							concurrency: 1
						},
						([t, edge, keep], c) =>
							Effect.sync(() => {
								const classes = valueClasses(t, edge)
								assert.ok(classes.length > 1, "a domain of one class tells nothing apart")
								for (const literal of classes) {
									assert.equal(literalProblem(literal, t), undefined)
								}
								const keys = Arr.map(classes, literalEqualityKey)
								assert.equal(new Set(keys).size, classes.length, "distinct classes")
								assert.equal(isRefined(compareParamType(t)), false)
								const bound = numericBoundOf(t)
								if (bound !== undefined) {
									for (const literal of classes) {
										assert.ok(
											withinBound(literal, bound),
											`a class within the bound (${bound.digits}, ${bound.scale})`
										)
									}
									c.note("a computed numeric")
									return
								}
								const desc = fieldDescOf(t)
								if (desc.kind === "text") {
									const refinement = succeeded(analyzeText(desc.patterns, SourceLoc("test", [])))
									assert.deepEqual(textOf(t), textInfo(refinement))
									for (const l of classes) {
										assert.ok(l.kind === "text" && accepts(refinement, l.value))
									}
								}
								const key = keyFieldType(t, keep)
								assert.ok(
									representableKey(key) ||
										(keep === "span" && (key.carrier === "range4" || key.carrier === "range8"))
								)
								if (key === t) {
									c.note("a type that is its own key type")
								}
								c.note(t.carrier)
								if (edge) {
									c.note("edge classes")
								}
							})
					)
				)
			})
	)
})

describe("value domains", () => {
	it.effect(
		"spell every stored value as its one value, in each of its twin spellings, a text the column's input reads",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a stored value is its class's one value, in its canonical spelling or a twin of the twin table"
						},
						suite: "unit/oracle-gen/domain-spelling",
						draw: drawn(
							(source) =>
								[
									source.draw(element(types)),
									source.draw(int(0, 12)),
									source.draw(int(0, 6)),
									source.draw(boolean)
								] as const
						),
						literal: Formatter.format,
						coverage: required<"canonical" | "twin">(["canonical", "twin"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([type, cls, sp, edge], c) =>
						Effect.sync(() => {
							const value = resolveValue(type, { cls, sp }, edge)
							const stored = resolveStored(type, { cls, sp }, edge)
							assert.deepEqual(stored.literal, value, "a spelling changes no value")
							switch (stored.spelling.kind) {
								case "canonical":
									c.note("canonical")
									return
								case "twin": {
									c.note("twin")
									assert.ok(Arr.contains(twinsOf(type, value), stored.spelling.text))
									return
								}
							}
						})
				)
			)
	)
})
