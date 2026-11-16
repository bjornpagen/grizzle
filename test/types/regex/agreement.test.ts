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
import { agreement } from "#test/types/batch/agreement.ts"
import { regexCases, regexNotes, regexProgram, regexRequired } from "#test/types/regex/agreement.ts"

/** Over drawn str.regex calls, the types admit exactly what the engine admits and infer what the oracle states. */
export const regex = agreement(regexCases, {
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
		}
	]
})
