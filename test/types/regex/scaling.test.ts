import { growthGate } from "#test/types/batch/measured.ts"
/**
 * str.regex's type cost (regex/scaling.ts): the inference of the shapes that cost it the most, a finite alternation, a
 * digit template, classes repeated into unions written out and cross products past TypeScript's union limit, the
 * program checked alone at three sizes an equal step apart, each step a whole number of the shapes' period.
 *
 * Properties: every program typechecks with no diagnostic; each step adds types and instantiations; and its
 * instantiations grow no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow; its types, which the
 * checker interns, are not judged by the law: test/types/batch/measured.ts): the second step adds no more than the first, so no
 * pattern costs more for the patterns before it. Oracle: the compiler's own counts, compared step against step.
 */
import { regexDimensions } from "#test/types/regex/scaling.dictionary.ts"

/**
 * Each dimension's program typechecks at its three sizes with no diagnostic, each step adding types and
 * instantiations, its instantiations growing no faster than linearly.
 */
export const scaling = growthGate(regexDimensions, {
	box: "the regex-scale program's one dimension, its patterns",
	kills: []
})
