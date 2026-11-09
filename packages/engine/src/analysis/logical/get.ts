import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { KeyProof } from "#compiler/ir/keys.ts"
import type { RelNode } from "#compiler/ir/rel.ts"

/**
 * The proof that the query rooted at `root`, a node of its analyzed DAG, has at most one row per parameter binding, its empty key, when get may read
 * it; or the refusal. A wider query is a type error in TypeScript; a description TypeScript did not check is refused
 * here.
 *
 * get eligibility: any query proved at most one row per parameter binding may be read as an Option, a keyed lookup
 * being the common case and an aggregate-only query another. The proof is the root's empty key, relative to its
 * parameters, which its normative cardinality summarizes.
 */
export const requireGet = (
	root: RelNode,
	loc: SourceLoc
): Result.Result<KeyProof, CompileError> => {
	for (const proof of root.meta.logicalKeys) {
		if (proof.key.length === 0) {
			return Result.ok(proof)
		}
	}
	return Result.err(getRefusal(loc))
}

/**
 * get's refusal at `loc` of a query not proved at most one row per parameter binding: what requireGet fails with, and
 * what a served read whose template proved none answers get with.
 */
export const getRefusal = (loc: SourceLoc): CompileError =>
	unsupported(
		loc,
		"get: a query proved at most one row per parameter binding, by a key its bindings cover, a take(1), or an aggregate whose group the parameters fix"
	)
