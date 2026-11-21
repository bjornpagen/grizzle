import { Array as Arr } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type ConstraintLaws,
	type ConstraintOwner,
	lawsOfConstraint
} from "#compiler/ir/products.ts"

/**
 * The one law the constraint `name` of `owner` serves, by the installation's constraint map, for a suite whose oracle
 * names one law per refusal: none where the map holds no such constraint. A constraint that serves several laws, whose
 * refusal names every one of them (ir/products.ts ConstraintLaws), is a schema such a suite does not draw, so meeting
 * one is a defect of the suite, thrown.
 */
export const soleLawOfConstraint = (
	laws: ConstraintLaws,
	owner: ConstraintOwner,
	name: string
): LawId | undefined => {
	const served = lawsOfConstraint(laws, owner, name)
	return served === undefined
		? undefined
		: soleLaw(served, `the constraint ${name} of ${owner.kind} ${owner.name}`)
}

/**
 * The one law of `laws`, every law a refusal names by its constraint (a migration's StatementFailed among them), for a
 * suite whose oracle names one law per refusal: none where it names none, and several, a constraint serving several
 * laws, a schema such a suite does not draw, thrown as a defect of the suite.
 */
export const soleLaw = (laws: ReadonlyArray<LawId>, what: string): LawId | undefined => {
	const [law, ...more] = laws
	if (more.length > 0) {
		throw new Error(
			`${what} serves ${more.length + 1} laws (${Arr.join(laws, ", ")}), where this suite's oracle names one`
		)
	}
	return law
}
