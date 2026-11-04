import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
/**
 * The generators' scalar types, value domains and spelling rule (test/support/oracle/gen/domain.ts): every generated
 * type's value classes hold only values the type stores exactly, one native-equality value per class, its edges
 * included; text carries the metadata its pattern derives and admits every generated text; a key field's type is
 * representable as a key; and a stored value is its class's one value, written in its canonical spelling or one of its
 * twins (gen/domain.ts twinSpellings).
 *
 * A comparison parameter binds as the unrefined base.
 */
import { decimalPayload } from "#compiler/ir/decimal.ts"
import { type TypedLiteral, literalProblem } from "#compiler/ir/expr.ts"
import { isRefined, type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import { btreeEntryBytes, btreeMaxItemSize, datumBound } from "#compiler/schema/representability.ts"
import { analyzeText, textInfo } from "#compiler/text/refinement.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
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

const roster = scalarOfSpec({
	carrier: "enum",
	roster: { closed: "K0", handles: ["H0", "H1", "H2"] }
})
const types: Arr.NonEmptyReadonlyArray<ScalarType> = Arr.append(
	Arr.map(allTypeSpecs, scalarOfSpec),
	roster
)

/**
 * Whether a type passes the key representability check as a one-field key (schema/representability.ts): its datum
 * bounded and its B-tree entry within BTMaxItemSize.
 */
const representableKey = (type: ScalarType): boolean => {
	const bound = datumBound(fieldDescOf(type))
	return bound.ok && btreeEntryBytes([bound.value]) <= btreeMaxItemSize
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
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/oracle-gen/domain-types",
							/** Every type, with and without its edge classes, each key kept as a span or as a scalar. */
							generator: (source) =>
								[
									source.draw(element(types)),
									source.draw(boolean),
									source.draw(element<"span" | "scalar">(["span", "scalar"]))
								] as const,
							literal: Formatter.format,
							limit: types.length * 4,
							coverage: requiredInSpace<TypeFeature>([
								"text",
								"numeric",
								"enum",
								"range4",
								"vector",
								"edge classes",
								"a type that is its own key type"
							]),
							caseHang: Duration.minutes(2)
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
								const desc = fieldDescOf(t)
								if (desc.kind === "text") {
									const refinement = succeeded(
										analyzeText(desc.source, desc.flags, SourceLoc("test", []))
									)
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

/** A value the domains must hold, or must not: the edges a type's equality and spelling turn on. */
interface Edge {
	readonly what: string
	readonly type: ScalarType
	readonly holds: (literal: TypedLiteral) => boolean
	readonly held: boolean
}

const numericSpelling = (l: TypedLiteral, text: string): boolean =>
	l.kind === "numeric" && decimalPayload(l.value) === text

const edges: ReadonlyArray<Edge> = [
	...Arr.map(["1.0", "1.00", "NaN", "Infinity"], (text) => ({
		what: `numeric ${text}, a display scale or a special value`,
		type: scalarOfSpec({ carrier: "numeric" }),
		holds: (l: TypedLiteral) => numericSpelling(l, text),
		held: true
	})),
	{
		what: "the signed zero",
		type: scalarOfSpec({ carrier: "float8" }),
		holds: (l) => l.kind === "float" && Object.is(l.value, -0),
		held: true
	},
	{
		what: "float NaN",
		type: scalarOfSpec({ carrier: "float8" }),
		holds: (l) => l.kind === "floatSpecial" && l.value === "NaN",
		held: true
	},
	{
		what: "supplementary-plane text",
		type: scalarOfSpec({ carrier: "text" }),
		holds: (l) => l.kind === "text" && Arr.some(Array.from(l.value), (ch) => ch.length === 2),
		held: true
	},
	{
		what: "infinity under a numeric typmod, which refuses it",
		type: scalarOfSpec({ carrier: "numericTypmod", precision: 3, scale: 1 }),
		holds: (l) => numericSpelling(l, "Infinity"),
		held: false
	},
	{
		what: "-0.25 under numeric(3,1), which would round it",
		type: scalarOfSpec({ carrier: "numericTypmod", precision: 3, scale: 1 }),
		holds: (l) => numericSpelling(l, "-0.25"),
		held: false
	}
]

describe("value domains", () => {
	it.effect(
		"hold the edges a type's equality and spelling turn on, and none their type cannot store",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/oracle-gen/domain-edges",
						generator: element(nonEmpty(edges, "the edges")),
						literal: Formatter.format,
						limit: edges.length,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					(e) =>
						Effect.sync(() => {
							assert.equal(Arr.some(valueClasses(e.type, false), e.holds), e.held, e.what)
						})
				)
			)
	)

	it.effect(
		"spell every stored value as its one value, in each of its twin spellings, a text the column's input reads",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
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
						caseHang: Duration.minutes(2)
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
