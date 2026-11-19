/**
 * The admitted grammar and its diagnostics.
 *
 * Each refusal carries its reason, pinned against ECMAScript itself: a MalformedDescription refusal is a pattern
 * `new RegExp(source, "u")` also throws on, and an UnsupportedOperation refusal is valid ECMAScript outside the admitted
 * fragment.
 *
 * - Unsupported: valid ECMAScript outside the fragment, each construct of the scanner's dictionary planted between
 *   drawn letters, is refused as UnsupportedOperation where the construct begins. Oracle: ECMAScript's RegExp reads it.
 * - Malformed: a random source is MalformedDescription exactly where ECMAScript's Unicode mode throws. Oracle: a
 *   differential against ECMAScript's RegExp.
 * - Text: a literal NUL or lone surrogate planted in a source is refused at its offset. Oracle: the specification.
 * - Flags: the builder refuses exactly the flags other than u and su, and a non-string source, as malformed. Oracle:
 *   the specification as a checker.
 * - Nesting: a pattern nested 1, 1,000 or 100,000 levels deep parses, its groups leaving no node, and its chains of
 *   repetitions and of optional groups as deep as written. Oracle: the specification, the nesting's own depth.
 *
 * Features: every planted construct; malformed, admitted and unsupported sources, and one malformed by a `)` that closes
 * no group; a NUL and a lone surrogate; admitted and other flags, a non-string source, no flags and every wild kind;
 * each nesting.
 */

import { expandedSize } from "@bjornpagen/grizzle-text/regex/ir"
import type { RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, array, element, finite, map, option } from "@bjornpagen/testing/gen"
import { drawnFeature, passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { admitRegex } from "#compiler/text/field.ts"
import { assert, matchesObject, succeeded } from "#test/support/assert.ts"
import {
	failure,
	type FlagsFeature,
	flagsGen,
	jsValid,
	lowercase,
	nested,
	type Nesting,
	nestings,
	parse,
	plantedSpace,
	plantedUnits,
	repetitionDepth,
	type SourceKind,
	sourceGen,
	type Spelled,
	spelling,
	strayClose,
	unit,
	unsupported
} from "#test/unit/text/parse.fixtures.ts"

/** Refusals with location and reason refuses valid ECMAScript outside the fragment where the construct begins, wherever it is planted. Its budget is its suite's before it was a property (test/unit/text/parse.test.ts at 4ca3036a): 600 runs and 600 steered cases. */
export const refusalsWithLocationAndReasonRefusesValidECMAScriptOutsideTheFragmentWhereTheConstructBeginsWhereverItIsPlanted =
	property.explore(plantedSpace, {
		needs: {},
		budget: { runs: 600, steered: 600 },
		situations: Arr.map(unsupported, spelling) satisfies ReadonlyArray<Reached<Spelled>>,
		check:
			(_, c: Case<Spelled>) =>
			({ planted, before, after }) =>
				Effect.sync(() => {
					c.note(spelling(planted))
					const source = `${before}${spelling(planted)}${after}`
					assert.equal(jsValid(source), true, source)
					matchesObject(failure(source, "u"), {
						reason: "UnsupportedOperation",
						offset: Arr.fromIterable(`${before}${planted.lead}`).length
					})
				}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's own RegExp, which reads every source"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/parse.ts",
				original:
					'\t\t\tthis.#unsupported(at, this.#text(at, at + 3), "lookahead assertions are not admitted")',
				replacement:
					'\t\t\tthis.#unsupported(at + 1, this.#text(at, at + 3), "lookahead assertions are not admitted")',
				why: "A lookahead is refused one code point past where it begins; the unsupported property fails."
			}
		]
	})

/** Refusals with location and reason is MalformedDescription exactly where ECMAScript's Unicode mode throws, on random sources. Its budget is its suite's before it was a property (test/unit/text/parse.test.ts at 4ca3036a): 30000 runs and 1000 steered cases. */
export const refusalsWithLocationAndReasonIsMalformedDescriptionExactlyWhereECMAScriptsUnicodeModeThrowsOnRandomSources =
	property.explore(
		aimed<ReadonlyArray<string>, SourceKind>(array(unit, { min: 0, max: 9 }), [
			["unsupported", plantedUnits],
			["malformed by a ')' that closes no group", strayClose]
		]),
		{
			needs: {},
			budget: { runs: 30000, steered: 1000 },
			situations: [
				"malformed",
				"admitted",
				"unsupported",
				"malformed by a ')' that closes no group"
			] satisfies ReadonlyArray<Reached<SourceKind>>,
			check: (_, c: Case<SourceKind>) => (units) =>
				Effect.sync(() => {
					const source = Arr.join(units, "")
					const result = parse(source, "u")
					const malformed = !result.ok && result.error.reason === "MalformedDescription"
					c.note(result.ok ? "admitted" : malformed ? "malformed" : "unsupported")
					if (malformed && result.error.construct === ")") {
						c.note("malformed by a ')' that closes no group")
					}
					assert.equal(malformed, !jsValid(source), source)
				}),
			oracle: { kind: "second-implementation", name: "ECMAScript's RegExp in Unicode mode" },
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/parse.ts",
					original: '\t\t\t\t\tthrow this.#malformed(this.#pos, ")", "unmatched \')\'")',
					replacement: "\t\t\t\t\tthis.#pos += 1\n\t\t\t\t\tcontinue",
					why: "An unmatched ')' is passed over, not refused as malformed; the malformed property fails."
				}
			]
		}
	)

/** Refusals with location and reason refuses a literal NUL and a lone surrogate in the source, at its offset. Its budget is its suite's before it was a property (test/unit/text/parse.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const refusalsWithLocationAndReasonRefusesALiteralNULAndALoneSurrogateInTheSourceAtItsOffset =
	property.explore(
		(source) => ({
			before: source.draw(lowercase(8)),
			after: source.draw(lowercase(8)),
			planted: source.draw(element(["\u0000", "\ud800", "\udfff"])),
			flags: source.draw(element<RegexFlags>(["u", "su"]))
		}),
		{
			needs: {},
			budget: { runs: 100, steered: 100 },
			situations: ["a NUL", "a lone surrogate"] satisfies ReadonlyArray<
				Reached<"a NUL" | "a lone surrogate">
			>,
			check:
				(_, c: Case<"a NUL" | "a lone surrogate">) =>
				({ before, after, planted, flags }) =>
					Effect.sync(() => {
						c.note(planted === "\u0000" ? "a NUL" : "a lone surrogate")
						matchesObject(failure(`${before}${planted}${after}`, flags), {
							reason: "UnsupportedOperation",
							offset: before.length
						})
					}),
			oracle: {
				kind: "specification",
				name: "NUL and a lone surrogate are no admitted text, refused where they stand"
			},
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/parse.ts",
					original:
						'\t\tif (c === 0) {\n\t\t\tthis.#unsupported(at, construct, "NUL is not admitted text, so a pattern may not spell it")\n\t\t} else if (isSurrogate(c)) {',
					replacement: "\t\tif (isSurrogate(c)) {",
					why: "A literal NUL in a source is admitted; the text property fails."
				}
			]
		}
	)

/** Refusals with location and reason refuses exactly the flags other than u and su, and a non-string source, as malformed, at the builder. Its budget is its suite's before it was a property (test/unit/text/parse.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const refusalsWithLocationAndReasonRefusesExactlyTheFlagsOtherThanUAndSuAndANonStringSourceAsMalformedAtTheBuilder =
	property.explore(
		(source) =>
			[source.draw(sourceGen), source.draw(map(option(flagsGen), Option.getOrUndefined))] as const,
		{
			needs: {},
			budget: { runs: 1000, steered: 1000 },
			situations: [
				"admitted flags",
				"other flags",
				"a non-string source",
				"no flags",
				...Arr.map(WILD_KINDS, (kind): FlagsFeature => `wild ${kind}`)
			] satisfies ReadonlyArray<Reached<FlagsFeature>>,
			check:
				(_, c: Case<FlagsFeature>) =>
				([sourceDrawn, flagsDrawn]) =>
					Effect.sync(() => {
						const source = passed(sourceDrawn)
						const flags = flagsDrawn === undefined ? undefined : passed(flagsDrawn)
						if (sourceDrawn.kind === "wild") {
							c.note(`wild ${sourceDrawn.wild.kind}`)
						}
						if (flagsDrawn?.kind === "wild") {
							c.note(`wild ${flagsDrawn.wild.kind}`)
						}
						const admittedFlags = flags === undefined || flags === "u" || flags === "su"
						c.note(
							typeof source !== "string"
								? "a non-string source"
								: flags === undefined
									? "no flags"
									: admittedFlags
										? "admitted flags"
										: "other flags"
						)
						const malformed = typeof source !== "string" || !admittedFlags
						/** The case by its kinds: a wild value is never rendered. */
						const call = `str.regex(${drawnFeature(sourceDrawn)}, ${flagsDrawn === undefined ? "no flags" : drawnFeature(flagsDrawn)})`
						const admitted = catchCompileError(() => admitRegex(source, flags))
						assert.equal(
							!admitted.ok && admitted.error.reason._tag === "MalformedDescription",
							malformed,
							call
						)
					}),
			oracle: {
				kind: "specification",
				name: "a Description's flags are u or su, and its source a string"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/text/field.ts",
					original: "\tif (flags !== undefined && !isRegexFlags(flags)) {",
					replacement: '\tif (flags !== undefined && typeof flags !== "string") {',
					why: "str.regex admits any flags string; the flags property fails."
				}
			]
		}
	)

/** Nesting parses a pattern nested to any depth, 100,000 levels included. */
export const nestingParsesAPatternNestedToAnyDepth100000LevelsIncluded = property.exhaust(
	finite((source) => ({
		nesting: source.draw(element(nestings)),
		depth: source.draw(element([1, 1_000, 100_000]))
	})),
	{
		needs: {},
		situations: nestings satisfies ReadonlyArray<Reached<Nesting>>,
		check:
			(_, n: Case<Nesting>) =>
			({ nesting, depth }) =>
				Effect.sync(() => {
					n.note(nesting)
					const ir = succeeded(parse(nested(nesting, depth), "u"), `${nesting}, ${depth} deep`)
					switch (nesting) {
						case "capturing groups":
						case "non-capturing groups":
							assert.deepEqual(ir, succeeded(parse("a", "u")), `${nesting}, ${depth} deep`)
							return
						case "a chain of + groups":
							assert.equal(repetitionDepth(ir), depth, `${nesting}, ${depth} deep`)
							return
						case "a chain of optional groups":
							assert.equal(expandedSize(ir), depth, `${nesting}, ${depth} deep`)
							return
					}
				}),
		oracle: {
			kind: "specification",
			name: "groups leave no node, and a chain of repetitions or of optional groups is as deep as written"
		},
		box: "every nesting, 1, 1,000 and 100,000 levels deep",
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/ir.ts",
				original:
					'\t\t\t\t\treturn n.arms.reduce((total, arm) => (arm.kind === "empty" ? total : total + of(arm)), 0)',
				replacement: "\t\t\t\t\treturn n.arms.reduce((total, arm) => total + of(arm), 0)",
				why: "An optional's empty arm counts as a written-out position; the nesting property fails."
			}
		]
	}
)
