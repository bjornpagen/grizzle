import { type CompileBound, type CompileError, resourceBound } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { BudgetKind, Budgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"

/** The budget a meter's refusal crossed (BudgetMeter.charge); undefined for any other refusal. */
export const budgetBoundOf = (
	error: CompileError
): Extract<CompileBound, { readonly kind: "budget" }> | undefined =>
	error.reason._tag === "ResourceBound" && error.reason.bound.kind === "budget"
		? error.reason.bound
		: undefined

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

/**
 * A meter of what one compilation consumes against its budgets (production's are core/policy.ts compileBudgets).
 * Exceeding a compiler resource bound yields a source-located error: CompileError{reason: 'ResourceBound'} located at
 * the declaration or expression whose charge crossed the bound. It never truncates: a refused charge is a failed
 * compilation, and the meter stays exhausted for that kind, so later charges fail too. A meter is local mutable state
 * owned by one compilation; it is never shared across compilations.
 */
export class BudgetMeter {
	readonly #limits: Budgets
	readonly #used: Record<BudgetKind, number> = {
		nodes: 0,
		fields: 0,
		sqlBytes: 0,
		params: 0,
		variants: 0
	}

	constructor(limits: Budgets) {
		this.#limits = { ...limits }
	}

	limit(kind: BudgetKind): number {
		return this.#limits[kind]
	}

	used(kind: BudgetKind): number {
		return this.#used[kind]
	}

	remaining(kind: BudgetKind): number {
		return Math.max(0, this.#limits[kind] - this.#used[kind])
	}

	/**
	 * Adds `amount` to `kind`, or refuses with ResourceBound located at `loc` when the total would exceed the limit.
	 */
	charge(kind: BudgetKind, amount: number, loc: SourceLoc): Result.Result<void, CompileError> {
		const needed = this.#used[kind] + amount
		this.#used[kind] = needed
		const limit = this.#limits[kind]
		if (needed <= limit) {
			return Result.ok(undefined)
		}
		return Result.err(resourceBound(loc, { kind: "budget", budget: kind, limit, needed }))
	}

	/** Charges the UTF-8 byte length of an emitted SQL text against sqlBytes. */
	chargeSql(text: string, loc: SourceLoc): Result.Result<void, CompileError> {
		return this.charge("sqlBytes", utf8Length(text), loc)
	}

	/** The usage so far, for diagnostics and measurement records, its keys in budgetKinds order. */
	usage(): Readonly<Record<BudgetKind, { readonly used: number; readonly limit: number }>> {
		const entry = (kind: BudgetKind) => ({ used: this.#used[kind], limit: this.#limits[kind] })
		return {
			nodes: entry("nodes"),
			fields: entry("fields"),
			sqlBytes: entry("sqlBytes"),
			params: entry("params"),
			variants: entry("variants")
		}
	}
}
