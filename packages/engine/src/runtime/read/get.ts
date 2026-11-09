import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"

/**
 * get's refusal at `loc` of a query not proved at most one row per parameter binding: what requireGet fails with, and
 * what a served read whose template proved none answers get with.
 */
export const getRefusal = (loc: SourceLoc): CompileError =>
	unsupported(
		loc,
		"get: a query proved at most one row per parameter binding, by a key its bindings cover, a take(1), or an aggregate whose group the parameters fix"
	)
