import type { Effect, Option } from "effect"
import type { ApplyError, ReadError } from "#adapter/errors/execution.ts"
import type { ApplyOutcome, Compiled, QueryResult } from "#adapter/types/db.ts"
import { builtMark, type CursorError, type ParamMap } from "#compiler/plan/common.ts"
import type { Page } from "#compiler/plan/read.ts"

/**
 * A compiled program's operations, over records A (its rows, or its read-backs), as a JavaScript caller sees it: every
 * operation, those its program does not allow refused before any SQL. A Db's workload handles are typed over them
 * (typedCompiled).
 */
export interface CompiledOps<A> {
	execute(params: ParamMap): Effect.Effect<QueryResult<A>, ReadError>
	get(params: ParamMap): Effect.Effect<Option.Option<A>, ReadError>
	page<Q>(params: ParamMap, request: unknown): Effect.Effect<Page<A, Q>, ReadError | CursorError>
	apply(params: ParamMap): Effect.Effect<ApplyOutcome<A>, ApplyError>
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
