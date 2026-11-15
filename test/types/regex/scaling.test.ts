/**
 * str.regex's type cost (regex/scaling.ts): the inference of the shapes that cost it the most, a finite alternation, a
 * digit template, classes repeated into unions written out and cross products past TypeScript's union limit, the
 * program checked alone at three sizes an equal step apart, each step a whole number of the shapes' period.
 *
 * Properties: every program typechecks with no diagnostic; each step adds types and instantiations; and its
 * instantiations grow no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow; its types, which the
 * checker interns, are not judged by the law: test/types/batch/measured.ts): the second step adds no more than the first, so no
 * pattern costs more for the patterns before it. Oracle: the compiler's own counts, compared step against step.
 *
 * Plant (~/.cache/grizzle-release/GREENTRUNK/plants): regex-scale-expand.patch infers a cross product's language by
 * expanding its union, past the limit, instead of deciding it by its count alone (RegexInfer with no LanguageCount):
 * `[ab]{18}` and `(?:[abc]|xy){12,14}` raise TS2590 from 60 patterns, the smallest size, so the program fails before
 * the law reads its counts.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assertClean, assertGrowthLaw, measuredSizes } from "#test/types/batch/measured.ts"
import { regexScaleSizes, regexScaleSource } from "#test/types/regex/scaling.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the regex-scale program", (it) => {
	it.effect(
		`typechecks ${Arr.join(
			Arr.map(regexScaleSizes.sizes, (n) => `${n}`),
			", "
		)} patterns, cross products past the union limit among them, with no diagnostic, its instantiations growing no faster than linearly`,
		() =>
			Effect.gen(function* () {
				const sizes = yield* measuredSizes("test/types/regex", regexScaleSizes, regexScaleSource)
				for (const s of sizes) {
					assertClean(s, "regex patterns")
				}
				assertGrowthLaw("regex patterns", regexScaleSizes, sizes)
			})
	)
})
