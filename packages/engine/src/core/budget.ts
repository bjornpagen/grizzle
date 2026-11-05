import { type CompileError, resourceBound } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * The step bound of the rewrite pass `rewrite` (lower/optimize/demand/frame.ts, its one caller): `steps` must not
 * exceed `limit`, or the pass is refused as ResourceBound (rewriteSteps) at `loc`.
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
