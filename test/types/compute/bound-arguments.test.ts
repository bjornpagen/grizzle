/**
 * The bound-argument agreement (test/support/agreement/bound-arguments.ts): over every form of rows argument a call of
 * a declared function passes, by Fn.rows and by Fn.row, the types admit exactly the calls the engine compiles, and
 * refuse a rows argument whose query's parameters are not all bound, a query of parameters passed unbound, by the
 * refusal a match of one names (types/core/phantom.ts RequireBound). Where the engine compiles a cell, the query's
 * parameters as its types state them are the ones the engine declares. Each form is a cell of the box; a batch's cells
 * are one program, checked disarmed. Oracle: the engine's compile of each cell's query.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boundProgram } from "#test/support/agreement/bound-arguments.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { boundBox } from "#test/types/compute/bound-arguments.dictionary.ts"

/** Over every form of rows argument a call passes, admits exactly what the engine compiles, its parameters the engine's. */
export const boundArguments = boxAgreement(finite(word(boundBox)), {
	box: "every form of rows argument a call of a declared function passes, by Fn.rows and by Fn.row: a query of no parameters; a query of a scalar parameter unbound, unbound beside its caller's parameter of its name, and bound to the caller's parameter, a variable and a constant; a query of a relation parameter unbound and bound to the caller's; a union whose second arm, a take whose count and an attachment whose child reads a parameter, each unbound and bound; and a query of no parameters beside a value argument of the caller's parameter",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: boundProgram,
	oracle: { kind: "second-implementation", name: "the engine's compile of each cell's query" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/compute/call.ts",
			original: "\t\t? RequireBound<A[K]>\n",
			replacement: "\t\t? unknown\n",
			why: "A rows argument is admitted whatever its parameters, as it was before (lane TYPEBIND): a query of parameters passed unbound typechecks where the engine refuses it, and every unbound cell's directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/core/phantom.ts",
			original:
				"B[K] extends Phantom<{ readonly sourceParams: infer SP }> ? SP : ParamsOfTerm<B[K]>",
			replacement:
				"B[K] extends Phantom<{ readonly sourceParams: infer SP }> ? unknown : ParamsOfTerm<B[K]>",
			why: "A bound rows argument contributes none of its bind map's parameters to its call's, so a query whose argument is bound to the caller's parameter or relation parameter states none where the engine declares it; the program fails."
		}
	]
})
