/**
 * A call of a declared function passes a closed id of its argument's own roster alone, a query calls a function of
 * values and rows of values alone, and a declaration states its null input, which its type carries
 * (test/types/compute/calls.ts):
 * over every form an argument of a closed id is passed by, a term, a handle, a name, a code or rows of a query, a cell
 * is admitted exactly where the value is of the argument's roster, and refused where it is another roster's, a name
 * no handle has or a code. Each form is a cell of the box; a batch's cells are one program, checked disarmed. Oracle:
 * the rule every term meets by, a closed id standing only where a value of its own roster does.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { callsBox } from "#test/types/compute/calls.dictionary.ts"
import { callsProgram } from "#test/types/compute/calls.ts"

/** Over every form an argument of a closed id is passed by, admits exactly its own roster's values. */
export const calls = boxAgreement(finite(word(callsBox)), {
	box: "every form a call of a declared function passes an argument of a closed id by: a term, a handle, a name, a code and rows of a query, of its own roster and of another; a query's call of a function of one row, of rows that hold rows, and taking one row; a query's read of a field of a function's one row, of rows of its roster's ids read as its own and as another's, of a value, of one row and of rows that hold rows, and of the fields of a volatile function's row and of a function of rows; and a declaration by its null input, strict, called, unstated and of another spelling, and a strict function's value",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: callsProgram,
	oracle: {
		kind: "specification",
		name: "the rule every term meets by: a closed id stands only where a value of its own roster does"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/compute/call.ts",
			original: "\t\t\t? Meets<D, S> | LiteralOf<H>",
			replacement: "\t\t\t? Meets<unknown, S> | LiteralOf<H>",
			why: "An argument meets any term of its SQL type, whatever its domain, so a variable of another roster's ids typechecks and its directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/call.ts",
			original: "\t\t\t? K\n\t\t\t: never\n\t\t: never\n}[keyof Fields]",
			replacement: "\t\t\t? K\n\t\t\t: never\n\t\t: K\n}[keyof Fields]",
			why: "A field of a value or of one row is a key of the call's fields, a source of never, so the cells that read one typecheck and their directives are unused; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/call.ts",
			original: '\tRow<Rows<Fields>>,\n\t"immutable" | "stable",\n\tFunctionNullInput\n>',
			replacement:
				'\tRow<Rows<Fields>>,\n\t"immutable" | "stable" | "volatile",\n\tFunctionNullInput\n>',
			why: "A volatile function's row is read by its fields, whose reads could not share its one evaluation, so its cell typechecks and its directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/call.ts",
			original:
				"\t\t? CallSource<FactOfFields<F>, BindMapParams<A>, F, CallReads<A>>\n\t\t: never\n}",
			replacement:
				"\t\t? CallSource<FactOfFields<F>, BindMapParams<A>, Carriers, CallReads<A>>\n\t\t: never\n}",
			why: "A field's rows are carried by no heading of their own, so a variable of them is untyped, passes for another roster's id, and that cell's directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/function.ts",
			original: "\treadonly volatility: V\n\treadonly nullInput: N\n",
			replacement: "\treadonly volatility: V\n\treadonly nullInput: FunctionNullInput\n",
			why: "A function's type carries every null input, not the one its declaration states, so a strict or a called declaration's read-back is no literal and its cell fails; the program fails."
		},
		{
			file: "packages/engine/src/schema/api.ts",
			original: "\t\treadonly volatility: V\n\t\treadonly nullInput: N\n",
			replacement: "\t\treadonly volatility: V\n\t\treadonly nullInput?: N\n",
			why: "A declaration may leave its null input unstated, a default the types choose for it, so the unstated cell typechecks and its directive is unused; the program fails."
		}
	]
})
