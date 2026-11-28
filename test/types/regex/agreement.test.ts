/**
 * The regex agreement (test/types/regex/agreement.ts): over drawn str.regex calls, a literal call typechecks exactly
 * when the engine admits its pattern, the declared classes apart; a finite language within the scan infers exactly its
 * members, a long source string, and a cross product its union, or past the union limit string, never by expanding it.
 * Each call is a block of one program a batch checks disarmed, beside TypeScript's union limit re-verified. Oracle: the
 * engine's admission (text/refinement.ts), and ECMAScript's acceptance of each member. The witnesses reach every form,
 * verdict, declared class and host claim. The scan's budget is type-level only, RegexScan's codeUnits
 * (types/fields/source.ts): nothing scans a source at run time, so the program's value of it is a constant of that
 * type, which stops typechecking once the budget moves.
 */
import { agreement } from "#test/support/types/batch/agreement.ts"
import { regexCases, regexNotes, regexProgram, regexRequired } from "#test/types/regex/agreement.ts"

/**
 * Over drawn str.regex calls, the types admit exactly what the engine admits and infer what the oracle states. Its
 * budget, 120 runs and the runner's 200 steered cases, is the pre-conversion suite's rotating count (120), restored
 * because it costs no more: at TEST_SEED=777, run beside the runner's default of 150, the whole run's process tree took
 * 37.8 CPU-s against 41.9, every situation reached and every kill killed alike (budgets/regex.*.txt)
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets, 2026-11-16, load 470 to 670).
 */
export const regex = agreement(regexCases, {
	budget: { runs: 120, steered: 200 },
	situations: regexRequired,
	notes: regexNotes,
	checking: "disarmed",
	program: regexProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's admission of each pattern, and ECMAScript's acceptance of each member"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/regex.ts",
			original: "\t\t\t\t: OnePlaceholderPerRun<regex.infer<N, F>>",
			replacement: "\t\t\t\t: OnePlaceholderPerRun<regex.infer<N, F>> | string",
			why: "Every inferred host type widens to string (types/fields/regex.ts RegexInfer); the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/fields/source.ts",
			original:
				"\t\t? [StepRejected<C, R, [K] extends [ClassFlag] ? true : false>] extends [never]",
			replacement: "\t\t? [never] extends [never]",
			why: "The scan reads every construct outside PostgreSQL's fragment as ArkRegex does, so the types admit a lookaround, a backreference, a lazy quantifier or an escaped NUL the engine refuses (types/fields/source.ts StepRejected); the agreement's program fails."
		}
	]
})
