/**
 * str.bytes's types (test/support/text/bytes.ts): a text a byte bound refines has its pattern's own type, both ways,
 * and so does a finite language's text under each drawn bound, whose type is no string; and it meets every text its
 * pattern meets, as a containment's source and as a key. Each drawn containment is a block of one program a batch
 * checks armed, which must raise no diagnostic. Oracle: the pattern-refined text's own type. The witnesses reach every
 * meet situation.
 */
import { bytesProgram, featuresOf, meetCaseGen, meetFeatures } from "#test/support/text/bytes.ts"
import { agreement } from "#test/support/types/batch/agreement.ts"

/**
 * A text a byte bound refines has its pattern's type, and meets every text its pattern meets. Its budget, 24 runs and
 * the runner's 200 steered cases, is the pre-conversion suite's rotating count (24), restored because it costs no more:
 * at TEST_SEED=777, run beside the runner's default of 150, the whole run's process tree took 35.9 CPU-s against 37.4,
 * every situation reached and every kill killed alike (budgets/bytes.*.txt)
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets, 2026-11-16, load 470 to 670).
 */
export const bytes = agreement(meetCaseGen, {
	budget: { runs: 24, steered: 200 },
	situations: meetFeatures,
	notes: featuresOf,
	checking: "armed",
	program: bytesProgram,
	oracle: { kind: "second-implementation", name: "the pattern-refined text's own type" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/text/field.ts",
			original: "\ttext: RegexText<Host>\n): RegexText<Host> => {",
			replacement: "\ttext: RegexText<Host>\n): RegexText<string> => {",
			why: "str.bytes is typed as a text whose host is string, no pattern's (text/field.ts bytesConstructor), so a finite language's bounded text is no longer its pattern's type; the program fails."
		}
	]
})
