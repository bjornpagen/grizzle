import { canonicalEquals, catchRefusal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import { dagDigestWithin } from "#compiler/ir/dag.ts"
import type { RelDag, RelNode } from "#compiler/ir/rel.ts"
import type {
	AttachedTree,
	ConservativeStatement,
	StatementRoots
} from "#compiler/lower/conservative/types.ts"
import type { Arrival, Sent } from "#compiler/lower/shapes/index.ts"

/** The share key of the sub-query rooted at `node`, a node of `dag`, whose enclosing nodes it may read. */
export const shareKey = (dag: RelDag, node: RelNode): Result.Result<string, CompileError> =>
	dagDigestWithin(dag, [node], "share")

/** A share group's first statement, whose text and parameters a later member must have to be fed, and its arrival. */
interface ShareGroup {
	readonly feeder: Sent
	readonly statement: ConservativeStatement
}

/**
 * Sharing a sub-query across statements in one snapshot (R25).
 *
 * Two statements executed in one snapshot over the same sub-query fingerprint and parameters compute the same set: two
 * attachments over one parent, or any pair a snapshot pipelines. R25 computes the shared sub-query once and feeds both
 * consumers, keyed on the fingerprint, never on a request option.
 *
 * - The share key of a sub-query is the semantic digest of the DAG it reaches (ir/dag.ts dagDigestWithin that root):
 *   allocation order, source locations and the proofs of its claimed keys do not enter it, the keys' columns and
 *   parameter names do, and so does every outer node a correlated child reads, so two attachments correlated to the
 *   same parent statement share, and imports with different parameter bindings never do.
 * - The fixed rule: the runtime feeds an attachment statement the rows of the first earlier attachment statement whose
 *   child has its share key, under the same parent rows, a fed parent's being its feeder's, when the two are the same
 *   text with the same parameters, so in one snapshot they deliver the same rows. A read-only snapshot creates no
 *   temporary relation: the runtime hands the feeder's rows to each statement it feeds.
 * - The window count, `count(*) OVER ()` fused into a page beside `get` of the aggregate-only count of its population,
 *   is a form R25 permits, never one it requires. A page and a `get` are separate calls, which no program sees
 *   together, and the fixed rule selects sharing, so no window count is built.
 *
 * Each statement of a delivered program with how the runtime has its rows, in one walk in flight order: every delivered
 * statement is sent, and an attachment statement is fed by its group's first statement, keyed by its child's share key
 * under its parent's rows (the sent statement whose rows they are), when it has that statement's text and parameters;
 * otherwise it is sent, and the first of its group.
 */
export const arrivalsOf = <S extends ConservativeStatement>(
	dag: RelDag,
	roots: StatementRoots<S>
): Result.Result<StatementRoots<S & { readonly arrival: Arrival }>, CompileError> =>
	catchRefusal(() => {
		let answers = 0
		const send = (): Sent => ({ kind: "sent", answer: answers++ })
		const groups = new Map<Sent, Map<string, ShareGroup>>()
		const attached = (
			tree: AttachedTree<S>,
			parent: Sent
		): AttachedTree<S & { readonly arrival: Arrival }> => {
			const key = shareKey(dag, tree.attach.child)
			if (!key.ok) {
				throw new Refusal(key.error)
			}
			const statement = tree.statement
			const byKey = groups.get(parent) ?? new Map<string, ShareGroup>()
			groups.set(parent, byKey)
			const group = byKey.get(key.value)
			const fed =
				group !== undefined &&
				statement.sql.text === group.statement.sql.text &&
				canonicalEquals(statement.params, group.statement.params, everyProperty)
			const arrival: Arrival = fed ? { kind: "fed", feeder: group.feeder } : send()
			const rows = arrival.kind === "fed" ? arrival.feeder : arrival
			if (group === undefined) {
				byKey.set(key.value, { feeder: rows, statement })
			}
			return {
				statement: { ...statement, arrival },
				attach: tree.attach,
				attachments: tree.attachments.map((a) => attached(a, rows))
			}
		}
		return mapNonEmpty(roots, (tree) => {
			const arrival = send()
			return {
				statement: { ...tree.statement, arrival },
				attachments: tree.attachments.map((a) => attached(a, arrival))
			}
		})
	})
