/**
 * A term the host evaluates (test/types/compute/hosted.ts): over the box of every scalar function computeSpecs marks
 * check false, widthBucket apart, and abs, each at every position a term stands in a schema, a cell is refused exactly
 * where the host evaluates its position (a contract predicate, a row check of a stored relation, a generated field)
 * and the roster marks its function, under the types' Refusal (types/core/phantom.ts Hosted), and admitted in a row
 * check of a derived relation and a selection, which read it in SQL. Each call is a cell of the box; a batch's cells are
 * one program, checked disarmed. Oracle: the roster the compiler refuses a check's operation by.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { hostedBox } from "#test/types/compute/hosted.dictionary.ts"
import { hostedProgram } from "#test/types/compute/hosted.ts"

/** Over every unhosted function and abs at every position, refuses exactly the roster's cells, and admits the rest. */
export const hosted = boxAgreement(finite(word(hostedBox)), {
	box: "every scalar function computeSpecs marks check false but widthBucket, abs, and a declared function's call, each in a row check of a stored relation, a contract predicate, a generated field, a row check of a derived relation and a selection",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: hostedProgram,
	oracle: {
		kind: "specification",
		name: "computeSpecs, the roster scalar/compute/typing.ts refuses a check's operation by"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/core/phantom.ts",
			original: "\tO extends UnhostedOrigin<unknown>",
			replacement: "\tO extends never",
			why: "No origin reads as unhosted (types/core/phantom.ts ReadsUnhosted), so every refused cell typechecks and its directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/call.ts",
			original: "\tUnhostedOrigin<CallReads<A>>,",
			replacement: "\tCallReads<A>,",
			why: "A declared function's call is of its operands' origin, unmarked, so its contract, row check and generated field cells typecheck and their directives are unused; the program fails."
		},
		{
			file: "packages/engine/src/types/fields/constructors.ts",
			original: '\t\tv: Scalar<DomainOf<B>, unknown, ContractValueOrigin, B["sql"], Infer<B>>',
			replacement: '\t\tv: Scalar<DomainOf<B>, unknown, unknown, B["sql"], Infer<B>>',
			why: "A contract's value is of unknown origin, which a union of origins absorbs, so a guarded unhosted term over it (Logic.when's origin) loses its mark and its contract cell typechecks; the program fails."
		}
	]
})
