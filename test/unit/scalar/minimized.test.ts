/**
 * A compile minimizes each pattern it proves anything of once (scalar/regex/patterns.ts CompilePatterns minimal): the
 * inclusion and length proofs (scalar/regex/inclusion.ts patternIncludes, bytesWithin) read each member's canonical DFA
 * from the compile's table, made the first time a proof compares it, where each proof determinized and minimized every
 * member again (text/regex/inclusion.ts inclusion over automata): 13.5 s of edullm's QTI database generate at
 * 94aa830e1 (its cpu profile, dfaOf under patternIncludes, every cast of a text into a refined text type a proof). The
 * minimizations are counted, never timed: V8's precise coverage counts minimalDfa's calls (kernel/calls.ts callCounts).
 *
 * The box, drawn: two to twelve proofs one compile makes, each of a conjunction of one or two patterns inside another,
 * over a pool of six admitted patterns nested in one another's languages and apart.
 *
 * Properties: every verdict is the verdict over members minimized afresh (a second implementation, the proof as it ran
 * at 8071f3a64); and the compile minimizes each distinct pattern its proofs compare once, however many proofs compare
 * it. Kill: each proof minimizing its members again.
 *
 * Features: a proof included; a proof refuted; a pattern compared twice.
 */

import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import { inclusion } from "@bjornpagen/grizzle-text/regex/inclusion"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { patternIncludes } from "#compiler/scalar/regex/inclusion.ts"
import { AnalyzedPatterns } from "#compiler/text/refinement.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { boxGen, distinctPatterns, memberPlaces } from "#test/unit/scalar/minimized.fixtures.ts"

type Situation = "a proof included" | "a proof refuted" | "a pattern compared twice"

/** Every verdict of a compile's proofs is the verdict over members minimized afresh. */
export const everyVerdictOfACompilesProofsIsTheVerdictOverMembersMinimizedAfresh = property.explore(
	boxGen,
	{
		needs: {},
		situations: [
			"a proof included",
			"a proof refuted",
			"a pattern compared twice"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (proofs) =>
			Effect.sync(() => {
				const patterns = new AnalyzedPatterns()
				const fresh = new AnalyzedPatterns()
				for (const proof of proofs) {
					const verdict = patternIncludes(proof.inner, proof.outer, patterns)
					const afresh = inclusion(
						mapNonEmpty(proof.inner, (p) => minimalDfa(fresh.parse(p).matcher.nfa, regexDfaLimits)),
						mapNonEmpty(proof.outer, (p) => minimalDfa(fresh.parse(p).matcher.nfa, regexDfaLimits)),
						regexDfaLimits
					)
					assert.deepEqual(verdict, afresh, "the verdict over members minimized afresh")
					if (verdict.kind === "included") {
						c.note("a proof included")
					}
					if (verdict.kind === "refuted") {
						c.note("a proof refuted")
					}
				}
				if (distinctPatterns(proofs) < memberPlaces(proofs)) {
					c.note("a pattern compared twice")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "inclusion over each member minimized afresh, the proof as it ran at 8071f3a64"
		},
		kept: [],
		kills: []
	}
)

/** A compile minimizes each distinct pattern its proofs compare once, however many proofs compare it. */
export const aCompileMinimizesEachDistinctPatternItsProofsCompareOnceHoweverManyProofsCompareIt =
	property.explore(boxGen, {
		needs: {},
		situations: [],
		check: () => (proofs) =>
			Effect.gen(function* () {
				const [, counts] = yield* callCounts(
					Effect.sync(() => {
						const patterns = new AnalyzedPatterns()
						for (const proof of proofs) {
							patternIncludes(proof.inner, proof.outer, patterns)
						}
					}),
					{ minimalDfa: { file: "packages/text/src/regex/dfa.ts", name: "minimalDfa" } }
				)
				assert.equal(
					counts.minimalDfa,
					distinctPatterns(proofs),
					`the compile minimizes its ${distinctPatterns(proofs)} distinct patterns once, not at each of ${memberPlaces(proofs)} member places`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one minimization of each distinct pattern for the compile"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/patterns.ts",
				original: "\t\tthis.#outcome ??= minimalDfa(this.#automaton(), regexDfaLimits)\n",
				replacement: "\t\tthis.#outcome = minimalDfa(this.#automaton(), regexDfaLimits)\n",
				why: "Each proof minimizes its members again, where it read the compile's table: the minimizations are the member places, a pattern compared twice minimized twice, and the search fails."
			}
		]
	})
