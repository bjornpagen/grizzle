/**
 * str.regex's host types are sound (test/types/text/contained.ts): every value ECMAScript accepts of an admitted
 * pattern, drawn from a family's strings and walks of the pattern's own NFA, inhabits `Infer` of its str.regex, and
 * every value two admitted patterns of one family both accept inhabits `Infer` of their str.and; and so does every
 * handwritten pattern's and every kept pattern's, each a box checked whole on every run. Each case is a block of one
 * program a batch checks armed, which must raise no diagnostic. Oracle: ECMAScript's own matcher. The witnesses
 * reach every family with a member, and the empty string as a member of a handwritten pattern.
 */
import { agreement, boxAgreement } from "#test/support/types/batch/agreement.ts"
import {
	containedCases,
	containedNotes,
	containedProgram,
	containedSituations,
	handwrittenProgram,
	keptProgram
} from "#test/types/text/contained.ts"
import { keptPatterns, handwrittenPatterns } from "#test/types/text/regex.dictionary.ts"

/** Infers a host type that contains every accepted value, of a pattern and of two patterns' conjunction. */
export const contained = agreement(containedCases, {
	situations: containedSituations,
	notes: containedNotes,
	checking: "armed",
	program: containedProgram,
	oracle: { kind: "second-implementation", name: "ECMAScript's own matcher" },
	kept: [],
	kills: []
})

/** Infers, for each kept pattern, a host type that contains the members it once refused. */
export const kept = boxAgreement(keptPatterns, {
	box: "every kept pattern and the members its host type once refused",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: keptProgram,
	oracle: { kind: "second-implementation", name: "ECMAScript's own matcher" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/compute/typing.ts",
			original:
				"exact === undefined\n\t\t\t\t? operands\n\t\t\t\t: operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at))",
			replacement:
				"exact === undefined ? operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at)) : operands",
			why: "Operator mutant 61b29d26cb at packages/engine/src/scalar/compute/typing.ts:3289 in <module>: `exact === undefined     ? operands     : operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at))` becomes `exact === undefined ? operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at)) : operands`; the property fails (the census, lane TESTPOLICY2)."
		}
	]
})

/**
 * Infers, for each family's handwritten pattern, a host type that contains the texts it accepts among the empty string
 * and every text of one or two letters of its family's alphabet.
 */
export const handwritten = boxAgreement(handwrittenPatterns, {
	box: "every handwritten pattern of the regex families the engine admits",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: handwrittenProgram,
	oracle: { kind: "second-implementation", name: "ECMAScript's own matcher" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/regex.ts",
			original: "\t\t\t\t: OnePlaceholderPerRun<regex.infer<N, F>>",
			replacement: '\t\t\t\t: Exclude<OnePlaceholderPerRun<regex.infer<N, F>>, "">',
			why: "The empty string is dropped from every inferred host type (types/fields/regex.ts RegexInfer); the program fails."
		}
	]
})
