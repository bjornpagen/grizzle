import { type CompileError, resourceBound } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { BudgetKind, Budgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * A one-shot bound that is not cumulative: the steps of the rewrite pass `rewrite` (lower/optimize/demand/frame.ts,
 * its one caller), `steps` of which must not exceed `limit`.
 */
export const checkBound = (
	rewrite: string,
	limit: number,
	steps: number,
	loc: SourceLoc
): Result.Result<void, CompileError> =>
	steps <= limit
		? Result.ok(undefined)
		: Result.err(resourceBound(loc, { kind: "rewriteSteps", rewrite, limit, needed: steps }))

/** Whether a meter still counts, or has refused a charge: then it keeps that first refusal and counts nothing more. */
type MeterState =
	| { readonly kind: "counting" }
	| { readonly kind: "refused"; readonly refusal: CompileError }

/**
 * A meter of what one compilation consumes against its budgets (production's are core/policy.ts compileBudgets).
 * Exceeding a compiler resource bound yields a source-located error: CompileError{reason: 'ResourceBound'} located at
 * the declaration or expression whose charge crossed the bound. It never truncates: a refused charge is a failed
 * compilation, and the meter stops at it, so every later charge returns that first refusal and counts nothing. A meter
 * is local mutable state owned by one compilation; it is never shared across compilations.
 */
export class BudgetMeter {
	readonly #limits: Budgets
	readonly #used: Record<BudgetKind, number> = { nodes: 0 }
	#state: MeterState = { kind: "counting" }

	constructor(limits: Budgets) {
		this.#limits = { ...limits }
	}

	/** What `kind` was charged, up to the first refused charge. */
	used(kind: BudgetKind): number {
		return this.#used[kind]
	}

	/**
	 * Adds `amount` to `kind`, or refuses with ResourceBound located at `loc` when the total would exceed the limit; once
	 * a charge is refused, the first refusal.
	 */
	charge(kind: BudgetKind, amount: number, loc: SourceLoc): Result.Result<void, CompileError> {
		const state = this.#state
		if (state.kind === "refused") {
			return Result.err(state.refusal)
		}
		const needed = this.#used[kind] + amount
		const limit = this.#limits[kind]
		if (needed <= limit) {
			this.#used[kind] = needed
			return Result.ok(undefined)
		}
		const refusal = resourceBound(loc, { kind: "budget", budget: kind, limit, needed })
		this.#state = { kind: "refused", refusal }
		return Result.err(refusal)
	}
}
