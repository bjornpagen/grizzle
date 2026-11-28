/**
 * Lowering a refinement to PostgreSQL: the constraint loops the IR rewrites away, the printed ARE read back for its
 * language and for the budgets' verdict, and the form a finite language is enforced by. The empty-language refusal is
 * emptiness.test.ts's.
 *
 * - Constraint loops: no admitted pattern's IR keeps an unbounded repetition whose body can match zero-width through an
 *   assertion. Oracle: a second implementation, a walk of the IR for such a repetition.
 * - Read back: the ARE a pattern prints, read back, recognizes the pattern's language, its own key or one past the
 *   canonical automaton. Oracle: universal, the printed ARE parsed again.
 * - Budgets: a pattern is admitted, or refused for one reason, exactly as the ARE it prints, read back. Oracle:
 *   universal, the verdict on a pattern is the verdict on its ARE.
 * - Finite form: a finite language is enforced by its shorter printed form, the IN list on a tie, and both forms
 *   recognize it. Oracle: the specification, the emitted DDL's UTF-8 bytes, and ECMAScript's RegExp test.
 *
 * Features: a source that loops through an assertion; compared and read back to its own key; admitted, refused at a
 * budget, spelled otherwise than its ARE; the IN list chosen, the regex chosen, a tie.
 */

import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { toAre } from "@bjornpagen/grizzle-text/regex/print"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, constant, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { analyzeText } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { analyzeLanguage } from "#test/support/fixtures/ir/scalar.ts"
import { jsMatcher } from "#test/support/regex.ts"
import {
	finiteLanguageOver,
	flagsGen,
	mostFiniteMembers,
	nestedPattern
} from "#test/support/unit/text/generators.ts"
import {
	areKey,
	assertionLoop,
	areSource,
	domainBytes,
	familyPattern,
	finiteCaseOf,
	type FormFeature,
	formsOf,
	loc,
	loops,
	tie,
	type Verdict
} from "#test/unit/text/lowering.fixtures.ts"

/** Constraint loops (scalar/regex/ir.ts repeat) leaves no repetition that loops through an assertion. Its budget is its suite's before it was a property (test/unit/text/lowering.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const constraintLoopsScalarRegexIrTsRepeatLeavesNoRepetitionThatLoopsThroughAnAssertion =
	property.explore(
		(source) =>
			[
				source.draw(oneOf([assertionLoop, nestedPattern, familyPattern])),
				source.draw(flagsGen)
			] as const,
		{
			needs: {},
			budget: { runs: 1000, steered: 1000 },
			situations: ["source loops through an assertion"] satisfies ReadonlyArray<
				Reached<"source loops through an assertion">
			>,
			check:
				(_, c: Case<"source loops through an assertion">) =>
				([source, flags]) =>
					Effect.sync(() => {
						const parsed = parsePattern(source, flags)
						if (parsed.ok && loops(parsed.value)) {
							c.note("source loops through an assertion")
						}
						const r = analyzeText([{ source, flags }], loc)
						if (r.ok) {
							assert.equal(loops(r.value.members[0].ir), false, `/${source}/${flags}`)
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "a walk of the IR for an unbounded repetition whose zero-width part asserts"
			},
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/ir.ts",
					original: "\t\t\t\t\t\tasserted: passable && paths.some((p) => p.asserted)",
					replacement: "\t\t\t\t\t\tasserted: passable && paths.every((p) => p.asserted)",
					why: "A sequence's zero-width paths count as asserted only when every item asserts, so a body such as `(?:a|$|)b?` is neither rewritten nor refused as a loop; the constraint loops property fails."
				}
			]
		}
	)

/** Reading a printed ARE back recognizes the language of the pattern it was printed from, on generated patterns of every family. Its budget is its suite's before it was a property (test/unit/text/lowering.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const readingAPrintedAREBackRecognizesTheLanguageOfThePatternItWasPrintedFromOnGeneratedPatternsOfEveryFamily =
	property.explore((source) => [source.draw(familyPattern), source.draw(flagsGen)] as const, {
		needs: {},
		budget: { runs: 1000, steered: 1000 },
		situations: ["compared", "read back to its own key"] satisfies ReadonlyArray<
			Reached<"compared" | "read back to its own key">
		>,
		check:
			(_, c: Case<"compared" | "read back to its own key">) =>
			([source, flags]) =>
				Effect.sync(() => {
					const r = analyzeText([{ source, flags }], loc)
					if (!r.ok) {
						return
					}
					const language = analyzeLanguage(r.value.members[0].ir)
					if (language.kind === "structure") {
						return
					}
					if (language.dfa.states.length === 0) {
						return assert.fail(`/${source}/${flags} is admitted with no member`)
					}
					c.note("compared")
					const key = areKey(r.value.members[0].are)
					if (key === r.value.key) {
						c.note("read back to its own key")
						return
					}
					if (key === undefined) {
						return
					}
					/**
					 * A key other than the pattern's own: the read-back pattern's language reaches no canonical automaton.
					 */
					const back = defined(
						areSource(r.value.members[0].are),
						`/${source}/${flags} as ${r.value.members[0].are} reads back`
					)
					const reparsed = succeeded(
						parsePattern(back, "su"),
						`/${source}/${flags} as ${r.value.members[0].are} parses back`
					)
					const readBack = analyzeLanguage(reparsed)
					assert.equal(
						readBack.kind === "structure",
						true,
						`/${source}/${flags} as ${r.value.members[0].are}`
					)
				}),
		oracle: {
			kind: "universal",
			name: "the printed ARE parsed again recognizes the pattern's language"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/ir.ts",
				original: "flat.push(item)",
				replacement: "{}",
				why: "Operator mutant 0ff7887c3d at packages/text/src/regex/ir.ts:238 in push: `flat.push(item)` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** Reading a printed ARE back admits a pattern exactly when it admits the ARE it prints as, read back. Its budget is its suite's before it was a property (test/unit/text/lowering.test.ts at 4ca3036a): 500 runs and 500 steered cases. */
export const readingAPrintedAREBackAdmitsAPatternExactlyWhenItAdmitsTheAREItPrintsAsReadBack =
	property.explore(nestedPattern, {
		needs: {},
		budget: { runs: 500, steered: 500 },
		situations: [
			"admitted",
			"refused at a budget",
			"spelled otherwise than its ARE"
		] satisfies ReadonlyArray<Reached<Verdict>>,
		check: (_, c: Case<Verdict>) => (source) =>
			Effect.sync(() => {
				const parsed = parsePattern(source, "u")
				if (!parsed.ok || parsed.value.kind === "never") {
					return
				}
				const are = toAre(parsed.value)
				const back = defined(areSource(are), `/${source}/u as ${are} reads back`)
				if (!parsePattern(back, "su").ok) {
					return
				}
				if (back !== source) {
					c.note("spelled otherwise than its ARE")
				}
				const own = analyzeText([{ source, flags: "u" }], loc)
				if (own.ok) {
					c.note("admitted")
				} else if (own.error.reason._tag === "ResourceBound") {
					c.note("refused at a budget")
				}
				const verdict = (r: typeof own): string =>
					r.ok ? `admitted as ${r.value.members[0].are}` : `refused as ${r.error.reason._tag}`
				assert.equal(
					verdict(analyzeText([{ source: back, flags: "su" }], loc)),
					verdict(own),
					`/${source}/u as ${are}`
				)
			}),
		oracle: {
			kind: "universal",
			name: "the budgets' verdict on a pattern is the verdict on its ARE"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/print.ts",
				original: `\treturn min === 0 && max === 1 ? "?" : \`{\${min},\${max}}\``,
				replacement: `\treturn min === 0 && max === 1 ? "?" : \`{\${min},\${max - 1}}\``,
				why: "A counted quantifier's maximum printed one short in the ARE; the read back and budgets properties fail."
			},
			{
				file: "packages/engine/src/text/refinement.ts",
				original: "are: toAre(ir), known: knownOf(table.minimal(pattern))",
				replacement: "are: source, known: knownOf(table.minimal(pattern))",
				why: "A pattern's ARE is its source as written, never the IR's print; the budgets property fails."
			}
		]
	})

/** The enforcement of a finite language prints no longer than its other form, the IN list on a tie, and both forms recognize the language. Its budget is its suite's before it was a property (test/unit/text/lowering.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const theEnforcementOfAFiniteLanguagePrintsNoLongerThanItsOtherFormTheINListOnATieAndBothFormsRecognizeTheLanguage =
	property.explore(
		aimed(
			finiteCaseOf((alphabet) => finiteLanguageOver(alphabet, mostFiniteMembers)),
			[["tie", finiteCaseOf(() => constant(tie))]]
		),
		{
			needs: {},
			budget: { runs: 1000, steered: 1000 },
			situations: ["IN list chosen", "regex chosen", "tie"] satisfies ReadonlyArray<
				Reached<FormFeature>
			>,
			check:
				(_, c: Case<FormFeature>) =>
				({ language, flags, strings }) =>
					Effect.sync(() => {
						const label = `/${language.source}/${flags}`
						const r = succeeded(
							analyzeText([{ source: language.source, flags: flags }], loc),
							label
						)
						const check = r.check
						if (check.kind === "tautology") {
							return assert.fail(`${label} is a finite language, no tautology`)
						}
						const { inList, regex } = formsOf(language, r)
						const listed = domainBytes(inList)
						const matched = domainBytes(regex)
						c.note(check.kind === "finite" ? "IN list chosen" : "regex chosen")
						if (listed === matched) {
							c.note("tie")
						}
						assert.equal(
							domainBytes(check),
							Math.min(listed, matched),
							`${label} is enforced by its shorter form`
						)
						assert.equal(
							check.kind,
							listed <= matched ? "finite" : "regex",
							`${label} is enforced by the IN list on a tie`
						)
						const members = new Set(language.members)
						if (check.kind === "finite") {
							assert.equal(check.members.length, members.size, `${label} lists its members`)
							for (const m of check.members) {
								assert.equal(members.has(m), true, `${label} lists ${Formatter.format(m)}`)
							}
						}
						const ofLanguage = jsMatcher(language.source, flags)
						for (const m of language.members) {
							assert.equal(ofLanguage(m), true, `${label} on ${m}`)
						}
						for (const s of strings) {
							assert.equal(ofLanguage(s), members.has(s), `${label} on ${s}`)
						}
					}),
			oracle: {
				kind: "specification",
				name: "the shorter emitted DDL by UTF-8 bytes, the IN list on a tie, and ECMAScript's RegExp test"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/text/refinement.ts",
					original: "\tinList.bytes <= regex.bytes ? inList : regex",
					replacement: "\tinList.bytes < regex.bytes ? inList : regex",
					why: "A finite language whose two forms print in as many bytes is enforced by the regex, not the IN list; the finite form property fails."
				}
			]
		}
	)
