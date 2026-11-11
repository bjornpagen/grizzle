import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import { dagDigestWithin } from "#compiler/ir/dag.ts"
import type { RelDag, RelNode } from "#compiler/ir/rel.ts"

/**
 * Sharing a sub-query across the parts of one statement (R25).
 *
 * Two parts of one statement compute their sub-queries in its one snapshot, so two over the same sub-query fingerprint
 * and parameters compute the same set: two attachments over one parent. R25 computes such a part once and feeds both
 * attachments, keyed on the fingerprint, never on a request option.
 *
 * - The share key of a sub-query is the semantic digest of the DAG it reaches (ir/dag.ts dagDigestWithin that root):
 *   allocation order, source locations and the proofs of its claimed keys do not enter it, the keys' columns and
 *   parameter names do, and so does every outer node a correlated child reads, so two attachments correlated to the
 *   same parent share, and imports with different parameter bindings never do.
 * - The fixed rule: an attachment with no attachment of its own is fed the rows of the first earlier attachment part
 *   under the same parent rows that has its parent key, correlation, delivered type, order and child heading and
 *   whose child has its share key (shapes/index.ts OptimizedDelivery #sameRows): the runtime reads that part's rows
 *   for it and stitches them under its own name. A read-only snapshot creates no temporary relation.
 * - The window count, `count(*) OVER ()` fused into a page beside `get` of the aggregate-only count of its population,
 *   is a form R25 permits, never one it requires. A page and a `get` are separate calls, which no program sees
 *   together, and the fixed rule selects sharing, so no window count is built.
 *
 * The share key of the sub-query rooted at `node`, a node of `dag`, whose enclosing nodes it may read.
 */
export const shareKey = (dag: RelDag, node: RelNode): Result.Result<string, CompileError> =>
	dagDigestWithin(dag, [node], "share")
