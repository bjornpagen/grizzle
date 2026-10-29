import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
/**
 * The generators' scalar types, value domains and spelling rule (test/support/oracle/gen/domain.ts): every generated
 * type's value classes hold only values the type stores exactly, one native-equality value per class, its edges
 * included; text carries the metadata its pattern derives and admits every generated text; a key field's type is
 * representable as a key; and a stored value is spelled once per case while a comparison operand spells itself.
 *
 * A comparison parameter binds as the unrefined base.
 */
import { decimalPayload } from "#compiler/ir/decimal.ts"
import { type TypedLiteral, literalProblem } from "#compiler/ir/expr.ts"
import { isRefined, type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import { btreeEntryBytes, btreeMaxItemSize, datumBound } from "#compiler/schema/representability.ts"
import { accepts, analyzeText, textInfo } from "#compiler/text/refinement.ts"
import { assert, defined, nonEmpty, succeeded, unorderedEqual } from "#test/support/assert.ts"
import {
	allTypeSpecs,
	compareParamType,
	fieldDescOf,
	keyFieldType,
	resolveValue,
	type Spelling,
	type SpellingMode,
	scalarOfSpec,
	valueClasses,
	literalEqualityKey
} from "#test/support/oracle/gen/domain.ts"
import { indices } from "#test/support/oracle/pick.ts"

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
 * bounded, its B-tree entry within BTMaxItemSize, and no vector, whose float32 equality is no key identity.
 */
const representableKey = (type: ScalarType): boolean => {
	if (type.carrier === "vector") {
		return false
	}
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
							features: features<TypeFeature>([
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
								const keys = Arr.map(classes, (cls) => {
									for (const literal of cls) {
										assert.equal(literalProblem(literal, t), undefined)
									}
									const own = [...new Set(Arr.map(cls, literalEqualityKey))]
									assert.equal(own.length, 1, "one native-equality value per class")
									return own
								})
								assert.equal(new Set(keys.flat()).size, classes.length, "distinct classes")
								assert.equal(isRefined(compareParamType(t)), false)
								const desc = fieldDescOf(t)
								if (desc.kind === "text") {
									const refinement = succeeded(
										analyzeText(desc.source, desc.flags, SourceLoc("test", []))
									)
									assert.deepEqual(textOf(t), textInfo(refinement))
									for (const l of classes.flat()) {
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
						features: noFeatures,
						caseHang: Duration.minutes(2)
					},
					(e) =>
						Effect.sync(() => {
							assert.equal(Arr.some(valueClasses(e.type, false).flat(), e.holds), e.held, e.what)
						})
				)
			)
	)

	it.effect(
		"spell a stored value once per case under perCase, and a comparison operand or a perFact value every way",
		(ctx) =>
			Effect.gen(function* () {
				type SpellFeature = SpellingMode | "stored" | "compare"
				const spellingGen: Gen<Spelling> = (source) => ({
					mode: source.draw(element<SpellingMode>(["perCase", "perFact", "twinned"])),
					choices: source.draw(array(int(0, 5), { min: 0, max: 4 })),
					edge: source.draw(boolean)
				})
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/oracle-gen/domain-spelling",
							draw: drawn(
								(source) =>
									[
										source.draw(element(types)),
										source.draw(int(0, 12)),
										source.draw(spellingGen),
										source.draw(element<"stored" | "compare">(["stored", "compare"]))
									] as const
							),
							literal: Formatter.format,
							features: features<SpellFeature>([
								"perCase",
								"perFact",
								"twinned",
								"stored",
								"compare"
							]),
							kept: [],
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						([type, cls, spelling, role], c) =>
							Effect.sync(() => {
								const classes = valueClasses(type, spelling.edge)
								const own = defined(classes[cls % classes.length], "the class")
								const spelled = Arr.map(indices(own.length), (sp) =>
									resolveValue(type, { cls, sp }, spelling, role)
								)
								for (const l of spelled) {
									assert.ok(Arr.some(own, (o) => literalEqualityKey(o) === literalEqualityKey(l)))
								}
								if (role === "stored" && spelling.mode === "perCase") {
									/** One spelling, whatever the value's own spelling index. */
									const first = defined(spelled[0], "a spelling")
									for (const l of spelled) {
										assert.deepEqual(l, first)
									}
								} else {
									unorderedEqual(spelled, own)
								}
								c.note(spelling.mode)
								c.note(role)
							})
					)
				)
			})
	)
})
