/**
 * The scalar type/engine agreement (test/support/agreement/compute.ts): every drawn term, predicate, aggregate, host
 * value and member read typechecks exactly when the engine builds and compiles it; a refusal the types name by a
 * Refusal names the engine's reason, every other refusal is structural; and an admitted case's term type, SQL type,
 * head and parameters equal the engine's, each asserted exactly. Each case is a block of one program a batch checks
 * disarmed. Oracle: the engine's construction and compilation of each case. The witnesses reach every construct
 * admitted and, where the catalogue can refuse it, refused, every Refusal the scalar catalogue names and every
 * inference the program asserts; the kept cases, a box of their own, reach by construction what a drawn case may miss.
 */
import { ReplayToken } from "@bjornpagen/testing/property"
import {
	computeAimed,
	computeKeptRequired,
	computeProgram,
	computeReached,
	computeSituations,
	computeSteeredCases
} from "#test/support/agreement/compute.ts"
import { agreement, boxAgreement } from "#test/types/batch/agreement.ts"
import { computeKept } from "#test/types/compute/compute.dictionary.ts"

/**
 * Over drawn cases, the types admit exactly what the engine compiles, name its refusal, and infer its types. Its
 * budget: the runner's own 150 runs, and 1200 steered cases (computeSteeredCases, measured: its 287 situations need
 * 1050). It runs the runner's default budget, not the pre-conversion suite's rotating count (400): at TEST_SEED=777, run
 * beside it, the default's whole process tree took 108.0 CPU-s against the old count's 109.2, both reaching every
 * situation and killing its kill (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/r2/compute.*.txt,
 * 2026-11-16, load 470 to 670).
 */
export const compute = agreement(computeAimed, {
	situations: computeSituations,
	budget: { runs: 150, steered: computeSteeredCases },
	notes: computeReached,
	checking: "disarmed",
	program: computeProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's construction and compilation of each case"
	},
	kept: [
		{
			token: ReplayToken(
				"test/types/compute/compute.test.ts#compute:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.1.3.0.0.0.0"
			),
			reason:
				"a cast of Cell's id into its own type, Type.cast(cell.id, Cell.fields.id), the id the tests' Id contract over uuid since 74d2ff677: the program names the contract's host type through Cell.fields.id, where the case died drawing it, no field of Cell named as the Id contract's (NEGZERO2's replay at main)",
			since: "2026-11-20"
		}
	],
	kills: [
		{
			file: "test/support/agreement/compute.ts",
			original: '\t[idName]: "id",\n',
			replacement: "",
			why: "The Id contract is no contract of a field of Cell, so a case that reads Cell's id dies drawing its program, no host type to name it by: the kept cast of the id fails."
		},
		{
			file: "packages/engine/src/types/compute/scalar.ts",
			original:
				'export type FirstTerm<A> = A extends FirstValue\n\t? Refusal<"a term first: a literal takes its place opposite a term, never first">',
			replacement: "export type FirstTerm<A> = A extends FirstValue\n\t? unknown",
			why: "A literal is admitted as an operation's first operand (types/compute/scalar.ts FirstTerm answers unknown for a JavaScript value); the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/compute/scalar.ts",
			original: "\t: [TypeOfTerm<A>] extends [Unordered]\n\t\t? true\n\t\t: false",
			replacement: "\t: [TypeOfTerm<A>] extends [Unordered]\n\t\t? false\n\t\t: false",
			why: "A closed id of a closed.unordered roster reads as ordered (types/compute/scalar.ts HasNoOrder answers false for it), so the types admit a comparison, a range, LEAST, GREATEST, min and max over it, which the engine refuses; the agreement's program fails."
		}
	]
})

/**
 * Over the kept cases, the types admit exactly what the engine compiles, name its refusal, and infer its types: a
 * digest and a byte guard in each of their situations, a translate over a map typed string, a match whose overlap the
 * engine decides, a branch reading its subject outside its parameter, and the closed reads, the translate, the
 * arithmetic and the pattern the types and the engine once disagreed on.
 */
export const computeKeptCases = boxAgreement(computeKept, {
	box: "every kept scalar case",
	situations: computeKeptRequired,
	notes: computeReached,
	checking: "disarmed",
	program: computeProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's construction and compilation of each case"
	},
	kept: [],
	kills: [
		{
			file: "test/support/agreement/compute.ts",
			original:
				'\t\treturn Str.includes(" has more digits than ")(text)\n\t\t\t? engineDecides.digits\n\t\t\t: engineDecides.literal\n',
			replacement: "\t\treturn undefined\n",
			why: "A bare literal compared with a term that does not hold it as written is a refusal the types share: the kept guard's bounds of more digits than cell.dec's numeric(10, 2) holds are held to a refusal the types never state, which they admit, and the property fails."
		},
		{
			file: "packages/engine/src/types/compute/compute.ts",
			original: "\t\tfrom: Fit<Fr, string>,\n\t\tto: Fit<To, string>",
			replacement: "\t\tfrom: Fr & string,\n\t\tto: To & string",
			why: "translate types its map as `Fr & string` and `To & string` again, from which TypeScript infers nothing for a string typed string, so a translate over a map computed at run time, which the engine admits, is typed never; the kept translates over the widened value fail their type assertions and the agreement's program fails."
		},
		{
			file: "packages/engine/src/scalar/compute/typing.ts",
			original:
				'\t\t\tconst holds =\n\t\t\t\tscope.kind === "parameter" ? held.includes(scope) : sameNode(scope.holds.subject, entry)',
			replacement: "\t\t\tconst holds = sameNode(scope.holds.subject, entry)",
			why: "Logic.when's lowering refines every occurrence of the guard's subject inside its branch, not only the branch's parameter (scalar/compute/typing.ts settle matches each enclosing guard by its subject's node alone), so the engine admits the kept power whose exponent reads the subject past the parameter, which the types refuse; the agreement's program fails."
		}
	]
})
