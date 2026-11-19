import { assert } from "@bjornpagen/testing/assert"
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
 */
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { literalProblem } from "#compiler/ir/expr.ts"
import { isRefined, numericBoundOf, textOf } from "#compiler/ir/scalar.ts"
import { refined } from "#compiler/scalar/compute/evaluate.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import {
	compareParamType,
	fieldDescOf,
	keyFieldType,
	literalEqualityKey,
	resolveStored,
	resolveValue,
	twinsOf,
	valueClasses
} from "#test/support/oracle/gen/domain.ts"
import { textInfo } from "#test/support/text.ts"
import {
	representableKey,
	spellingGen,
	typeBox,
	type TypeFeature,
	withinBound
} from "#test/unit/oracle-gen/domain.fixtures.ts"

/** Generated scalar types hold only exactly stored values, one native-equality value per class, and declare representable keys. */
export const generatedScalarTypesHoldOnlyExactlyStoredValuesOneNativeEqualityValuePerClassAndDeclareRepresentableKeys =
	property.exhaust(finite(typeBox), {
		needs: {},
		situations: [
			"text",
			"numeric",
			"code",
			"range4",
			"vector",
			"edge classes",
			"a type that is its own key type",
			"a computed numeric",
			"a contract's predicate"
		] satisfies ReadonlyArray<Reached<TypeFeature>>,
		check:
			(_, c: Case<TypeFeature>) =>
			([t, edge, keep]) =>
				Effect.sync(() => {
					const classes = valueClasses(t, edge)
					assert.ok(classes.length > 1, "a domain of one class tells nothing apart")
					for (const literal of classes) {
						assert.equal(literalProblem(literal, t), undefined)
						assert.ok(
							refined(literal, t, new CompilePatterns()).ok,
							"a class the type admits, every contract level's predicate holding of it"
						)
					}
					if (t.contract?.predicate !== undefined) {
						c.note("a contract's predicate")
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
				}),
		oracle: {
			kind: "specification",
			name: "the engine's literal check, key representability, text analysis and numeric bound"
		},
		box: "every generated type, computed numerics included, with and without its edge classes, each key kept as a span or as a scalar",
		kept: [],
		kills: [
			{
				file: "test/support/oracle/gen/domain.ts",
				original:
					"\t\t(literal) => literalProblem(literal, type) === undefined && admittedAt(literal, type)",
				replacement: "\t\t(literal) => literalProblem(literal, type) === undefined",
				why: "A type's value classes are drawn through the base-only literal check, as before: natural over bigint keeps int8's negatives, which its predicate refuses, so a generated query's natural-typed literal is one no schema's literal can be (per-evaluation's 23514 on natural's domain at follow-up 5's e75c06e31); this property fails."
			},
			{
				file: "packages/engine/src/ir/expr.ts",
				original: `\t\t\treturn inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${carrier}\``,
				replacement: `\t\t\treturn inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : undefined`,
				why: `Operator mutant (arm-swap) at packages/engine/src/ir/expr.ts:880 in literalProblem: \`inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${car\` becomes \`inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : und\`; the property fails (lane CATCH, grizzle 0baff5d6).`
			}
		]
	})

/**
 * Value domains spell every stored value as its one value, in each of its twin spellings, a text the column's input
 * reads.
 *
 * Budget: its suite's count before the conversion (unit/oracle-gen/domain-spelling: 300 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const valueDomainsSpellEveryStoredValueAsItsOneValueInEachOfItsTwinSpellingsATextTheColumnsInputReads =
	property.explore(spellingGen, {
		needs: {},
		situations: ["canonical", "twin"] satisfies ReadonlyArray<Reached<"canonical" | "twin">>,
		check:
			(_, c: Case<"canonical" | "twin">) =>
			([type, cls, sp, edge]) =>
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
				}),
		oracle: {
			kind: "specification",
			name: "a stored value is its class's one value, in its canonical spelling or a twin of the twin table"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: "\t\t\tif (!(literal.start < literal.end)) {",
				replacement: "\t\t\tif (!(literal.start >= literal.end)) {",
				why: "Operator mutant (comparison) at packages/engine/src/ir/expr.ts:948 in literalProblem: `<` becomes `>=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
