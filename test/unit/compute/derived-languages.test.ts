/**
 * A text's derived languages are analyzed once for its own language, however many compiles type them (scalar/compute/
 * typing.ts derivedLanguages): the language of its collapse (Text.collapse) and of its image under a character map
 * (Text.lowerAscii's ASCII fold), each the patterns of its own patterns' images the text analysis admits and their
 * language, made where a typing first meets the text's language (ir/scalar.ts RegexRef, one value however many schemas,
 * levels and law models type a text of it) and read from it by every later typing. A generate compiles its
 * installation's schemas many times: qti-database's analyzed 534 patterns, now 254.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts). The
 * box: one to three patterns over one family's alphabet, a text field of each, and generated fields of its collapse and
 * of its ASCII fold; the schema built afresh and owned once, then its law model compiled once and twice more. The two
 * later compiles derive no image again: no pattern's collapse sources (scalar/regex/whitespace.ts collapseSources) and
 * no image under a map (scalar/regex/translate.ts imageOf) are computed again.
 *
 * Features: one pattern, several patterns, and a first compile deriving the images, of a text of a language no earlier
 * case typed (a pattern the analysis erases is any text, whose derived languages the module holds).
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int, uniqueArray } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { regexField } from "#compiler/text/field.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { ownedInput } from "#test/support/policy.ts"
import { admittedPatternOver, families } from "#test/unit/text/generators.ts"

type DerivedFeature = "one pattern" | "several patterns" | "a first compile deriving"

/** Any text, the type each generated field is declared at. */
const anyText = regexField("^.*$", ["su"])

/** One to three distinct patterns over one family's alphabet. */
const patternsGen: Gen<Arr.NonEmptyReadonlyArray<string>> = (source) => {
	const family = defined(families[source.draw(int(0, families.length - 1))], "a family")
	const admitted = admittedPatternOver(family.alphabet)
	const drawn = source.draw(uniqueArray(admitted, (p) => element([p]), { min: 1, max: 3 }))
	return Arr.isReadonlyArrayNonEmpty(drawn) ? drawn : [source.draw(admitted)]
}

/**
 * The schema of a case, built afresh: a relation of a text field t<i> of each pattern, and for each, generated fields
 * of its collapse, c<i>, and of its ASCII fold, f<i>.
 */
const schemaOf = (patterns: Arr.NonEmptyReadonlyArray<string>) =>
	schema(
		"Derived",
		[
			generatedRelation(
				"T",
				{
					id: Id,
					...Rec.fromEntries(Arr.map(patterns, (p, i) => [`t${i}`, regexField(p, ["u"])] as const))
				},
				["id"],
				(row: Readonly<Record<string, unknown>>) =>
					Rec.fromEntries(
						Arr.flatMap(patterns, (_, i) => [
							[`c${i}`, generatedField(anyText, computeCore.collapse(row[`t${i}`]), [])] as const,
							[`f${i}`, generatedField(anyText, computeCore.lowerAscii(row[`t${i}`]), [])] as const
						])
					),
				[]
			)
		],
		[],
		[]
	)

/** A derived image computed: a pattern's collapse sources, or its image under a character map. */
const derivationSites = Object.freeze({
	collapsed: { file: "packages/engine/src/scalar/regex/whitespace.ts", name: "collapseSources" },
	imaged: { file: "packages/engine/src/scalar/regex/translate.ts", name: "imageOf" }
})

/**
 * A text's derived languages are typed once for its own language: after one compile of a schema built afresh, two more
 * compiles of it compute no collapse source and no image again, where each compile typing them anew computes them once
 * a compile.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTextsDerivedLanguagesAreAnalyzedOnceForItsOwnLanguageHoweverManyCompilesTypeThem =
	property.explore(patternsGen, {
		needs: {},
		situations: [
			"one pattern",
			"several patterns",
			"a first compile deriving"
		] satisfies ReadonlyArray<Reached<DerivedFeature>>,
		check: (_, k: Case<DerivedFeature>) => (patterns) =>
			Effect.gen(function* () {
				k.note(patterns.length === 1 ? "one pattern" : "several patterns")
				const owned = succeeded(ownedInput(schemaOf(patterns)), "the schema owns")
				const compile = () =>
					succeeded(compileLaws(owned, { kind: "planned" }), "the schema compiles")
				const [, first] = yield* callCounts(Effect.sync(compile), derivationSites)
				if (first.collapsed > 0 && first.imaged > 0) {
					k.note("a first compile deriving")
				}
				const [, later] = yield* callCounts(
					Effect.sync(() => {
						compile()
						compile()
					}),
					derivationSites
				)
				assert.equal(later.collapsed, 0, "two later compiles derive no collapse again")
				assert.equal(later.imaged, 0, "two later compiles derive no image again")
			}),
		oracle: {
			kind: "specification",
			name: "no derived image computed after the first compile of a schema (kernel/calls.ts callCounts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\tderived.set(derivation, made)\n",
				replacement: "",
				why: "A text's derived languages are not held by its own language, so every compile types its collapse and its fold anew, deriving every pattern's images again: two later compiles derive them twice."
			}
		]
	})
