import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { ApplyError, ReadError } from "#adapter/errors/execution.ts"
import type {
	ApplyOutcome,
	Compiled,
	ExecutedStatement,
	FactsApply,
	QueryResult,
	RefreshHandle,
	StatementPlan
} from "#adapter/types/db.ts"
import type { CursorError, ParamMap } from "#compiler/plan/common.ts"
import type { Page } from "#compiler/plan/read.ts"
import { builtMark } from "#compiler/plan/runtime.ts"

/**
 * A compiled program's operations, over records A (its rows, or its read-backs), as a JavaScript caller sees it: every
 * operation, those its program does not allow refused before any SQL. A Db's workload handles are typed over them
 * (typedCompiled, refreshHandle).
 */
export interface CompiledOps<A> {
	execute(params: ParamMap): Effect.Effect<QueryResult<A>, ReadError>
	get(params: ParamMap): Effect.Effect<Option.Option<A>, ReadError>
	page<Q>(params: ParamMap, request: unknown): Effect.Effect<Page<A, Q>, ReadError | CursorError>
	apply(params: ParamMap): Effect.Effect<ApplyOutcome<A>, ApplyError>
	readonly refresh: Effect.Effect<void, ApplyError>
}

/**
 * A served change member's operations whose ChangeSet holds array members, over its read-backs A: each apply takes the
 * call's facts beside its parameters (types/db FactsApply); every other operation is refused before any SQL.
 */
export interface FactsOps<A> extends Omit<CompiledOps<A>, "apply"> {
	apply(facts: unknown, params: ParamMap): Effect.Effect<ApplyOutcome<A>, ApplyError>
}

/** A served member's operations, whichever their shape: what a caller reads a member through. */
export type MemberOps<A> = CompiledOps<A> | FactsOps<A>

/** A served member's operations: a program's (CompiledOps), or a change's that takes each call's facts (FactsOps). */
export type ServedOps<A> =
	| { readonly kind: "program"; readonly ops: CompiledOps<A> }
	| { readonly kind: "facts"; readonly ops: FactsOps<A> }

/** A served read member's explains, as a JavaScript caller sees them (types/db ReadExplain). */
export interface ExplainOps {
	explain(params: ParamMap): Effect.Effect<ReadonlyArray<StatementPlan>, ReadError>
	explainAnalyze(params: ParamMap): Effect.Effect<ReadonlyArray<ExecutedStatement>, ReadError>
}

/**
 * A served member's explains, by what its handle takes (types/db WorkloadHandles): a read's (ExplainOps); a change's
 * estimates, for each call's parameters (ChangeExplain) or, where its ChangeSet holds array members, its facts beside
 * them (FactsExplain); and a refresh's none.
 */
export type MemberExplains =
	| { readonly kind: "read"; readonly ops: ExplainOps }
	| {
			readonly kind: "params"
			readonly explain: (params: ParamMap) => Effect.Effect<ReadonlyArray<StatementPlan>, ReadError>
	  }
	| {
			readonly kind: "facts"
			readonly explain: (
				facts: unknown,
				params: ParamMap
			) => Effect.Effect<ReadonlyArray<StatementPlan>, ReadError>
	  }
	| { readonly kind: "none" }

/** The members a handle holds of a member's explains, each its own operation. */
export const explainsOf = (explains: MemberExplains): object => {
	switch (explains.kind) {
		case "read":
			return {
				explain: (params: ParamMap) => explains.ops.explain(params),
				explainAnalyze: (params: ParamMap) => explains.ops.explainAnalyze(params)
			}
		case "params":
		case "facts":
			return { explain: explains.explain }
		case "none":
			return {}
	}
}

/** The typed handle of a compiled program X over records A, on a Db of S (types/db Compiled). */
export const typedCompiled = <S, X, A>(ops: CompiledOps<A>): Compiled<S, X, A> => {
	const handle: Compiled<S, X, A> = {
		...builtMark,
		execute: (params) => ops.execute(params),
		get: (params) => ops.get(params),
		page: (params, request) => ops.page<X>(params, request),
		apply: (params) => ops.apply(params)
	}
	return Object.freeze(handle)
}

/**
 * The typed handle of a change member X over its read-backs A, on a Db of S, whose ChangeSet holds array members
 * (types/db WorkloadHandles): its apply takes each call's facts beside its parameters (FactsApply).
 */
export const factsCompiled = <S, X, A>(
	ops: FactsOps<A>
): Omit<Compiled<S, X, A>, "page" | "apply"> & FactsApply<X, A> => {
	const handle: Omit<Compiled<S, X, A>, "page" | "apply"> & FactsApply<X, A> = {
		...builtMark,
		execute: (params) => ops.execute(params),
		get: (params) => ops.get(params),
		apply: (facts, params) => ops.apply(facts, params)
	}
	return Object.freeze(handle)
}

/** The typed handle of a refresh member (types/db RefreshHandle): its one operation. */
export const refreshHandle = (ops: CompiledOps<unknown>): RefreshHandle =>
	Object.freeze({ refresh: ops.refresh })
