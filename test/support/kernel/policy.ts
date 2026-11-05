import { element, type Gen, production } from "@grizzle/testing/gen"
import { Array as Arr } from "effect"
import type { CompileBound, CompileError } from "#compiler/core/errors.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import {
	type BudgetKind,
	type Budgets,
	budgetKinds,
	compileBudgets
} from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import { refusalLoc } from "#test/support/assert.ts"

/**
 * A limit: production's constant five times in six, otherwise one of the small values.
 *
 * Limits drawn per case, passed to the function that decides them.
 *
 * Grizzle's thresholds (core/policy.ts) are plain constants, and no test may depend on their values. A test of a
 * decision a threshold drives calls the deciding function with a limit drawn here, through that function's own
 * parameter, never by changing a global. Each draw offers production's constant first, so a failing case shrinks
 * toward the limit in force, then small values that put both sides of the limit within a small case.
 */
export const limitGen = (inForce: number, small: Arr.NonEmptyReadonlyArray<number>): Gen<number> =>
	production(inForce, small)

/**
 * The compiler budgets a budgeted case draws, production's first, then values small enough that the queries and
 * schemas the generators draw cross them now and then. A meter built over a draw either admits a compilation as it
 * admits it under production's budgets or refuses it with a ResourceBound naming the budget it crossed.
 */
export const budgetsGen: Gen<Budgets> = (source) => ({
	nodes: source.draw(element([compileBudgets.nodes, 8, 32, 128]))
})

/** A feature of drawn budgets: each budget at a value other than production's, with its value. */
export type BudgetFeature = `budgets.${BudgetKind}=${number}`

export const budgetFeatures = (budgets: Budgets): ReadonlyArray<BudgetFeature> =>
	Arr.flatMap(budgetKinds, (kind): ReadonlyArray<BudgetFeature> =>
		budgets[kind] === compileBudgets[kind] ? [] : [`budgets.${kind}=${budgets[kind]}`]
	)

/** The budget a meter's refusal crossed (core/budget.ts BudgetMeter.charge); undefined for any other refusal. */
export const budgetBoundOf = (
	error: CompileError
): Extract<CompileBound, { readonly kind: "budget" }> | undefined =>
	error.reason._tag === "ResourceBound" && error.reason.bound.kind === "budget"
		? error.reason.bound
		: undefined

/**
 * The budget a compilation's refusal under `budgets` crossed, or why the refusal is not one a budget may cause: a
 * ResourceBound names one of the budgets at that budget's limit, with a need above it, located where the charge
 * crossed it (core/budget.ts). The budget, limit and need are read from the error's typed bound, never from its
 * capability text. Any other refusal is a defect of the compilation under those budgets.
 */
export const budgetRefusal = (
	error: CompileError,
	budgets: Budgets
): Result.Result<BudgetKind, string> => {
	const refused = error.message
	if (error.reason._tag !== "ResourceBound") {
		return Result.err(`refused other than by a budget: ${refused}`)
	}
	const bound = budgetBoundOf(error)
	if (bound === undefined) {
		return Result.err(`a ResourceBound that names no compiler budget: ${refused}`)
	}
	const limit = budgets[bound.budget]
	if (bound.limit !== limit) {
		return Result.err(
			`a ResourceBound that names budgets.${bound.budget} at another limit than ${limit}: ${refused}`
		)
	}
	if (bound.needed <= bound.limit) {
		return Result.err(`a ResourceBound whose need fits its limit: ${refused}`)
	}
	if (formatLoc(refusalLoc(error)) === "") {
		return Result.err(`a ResourceBound at no location: ${refused}`)
	}
	return Result.ok(bound.budget)
}
