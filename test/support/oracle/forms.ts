import { Array as Arr } from "effect"
import {
	type ConservativeParamSlot,
	flight,
	mapTree,
	type StatementRoots
} from "#compiler/lower/conservative/types.ts"
import {
	type FusedStatement,
	type OptimizedStatement,
	oneForm
} from "#compiler/lower/shapes/index.ts"

/** Each statement's large form, when it has one: the large mode's statement, read from the form by `fused`. */
export const largeStatements = <C, L, Slot extends ConservativeParamSlot>(
	statements: ReadonlyArray<OptimizedStatement<C, L, Slot>>,
	fused: (large: L) => FusedStatement<Slot>
): ReadonlyArray<FusedStatement<Slot>> =>
	Arr.flatMap(statements, (s) => (s.forms.kind === "chosen" ? [fused(s.forms.large)] : []))

/**
 * The per-execution forms of an optimized program's statements, as the oracles run them.
 *
 * Each statement that holds a large form: its position, and the program's statements with its large form in its
 * place, as an execution whose choice exceeds its threshold sends them.
 */
export const largeFormPrograms = <C, L>(
	roots: StatementRoots<OptimizedStatement<C, L>>,
	fused: (large: L) => FusedStatement
): ReadonlyArray<{
	readonly statement: number
	readonly roots: StatementRoots<OptimizedStatement>
}> =>
	Arr.flatMap(flight(roots), (s, i) => {
		const forms = s.forms
		if (forms.kind === "one") {
			return []
		}
		const large: OptimizedStatement = { ...fused(forms.large), forms: oneForm, arrival: s.arrival }
		return [
			{ statement: i, roots: mapTree(roots, (t, j): OptimizedStatement => (j === i ? large : t)) }
		]
	})
