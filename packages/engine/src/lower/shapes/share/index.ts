import { canonicalEquals, catchRefusal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import { dagDigestWithin } from "#compiler/ir/dag.ts"
import type { RelDag, RelNode } from "#compiler/ir/rel.ts"
import type { ConservativeStatement } from "#compiler/lower/conservative/types.ts"
import type { Arrival, Sent } from "#compiler/lower/shapes/index.ts"
import type { AttachedTree, StatementRoots } from "#compiler/runtime/lower/tree.ts"

/** The share key of the sub-query rooted at `node`, a node of `dag`, whose enclosing nodes it may read. */
export const shareKey = (dag: RelDag, node: RelNode): Result.Result<string, CompileError> =>
	dagDigestWithin(dag, [node], "share")

/** A share group's first statement, whose text and parameters a later member must have to be fed, and its arrival. */
interface ShareGroup {
	readonly feeder: Sent
	readonly statement: ConservativeStatement
}

/** An attachment statement the runtime sends, the child it delivers, and its rows. */
interface SentSibling {
	readonly statement: ConservativeStatement
	readonly child: RelNode
	readonly rows: Sent
}

/**
 * The attachment statements under one parent's rows, in flight order. Until one has the text and parameters of an
 * earlier one, none is fed, so every one is sent and no share key decides anything: they are held as sent. From the
 * first that has, each is held by its child's share key, the first of each key its group's feeder.
 */
type Siblings =
	| { readonly kind: "sent"; readonly sent: Array<SentSibling> }
	| { readonly kind: "keyed"; readonly groups: Map<string, ShareGroup> }

/** Whether two statements are one text with the same parameters, so in one snapshot they deliver the same rows. */
const sameStatement = (a: ConservativeStatement, b: ConservativeStatement): boolean =>
	a.sql.text === b.sql.text && canonicalEquals(a.params, b.params, everyProperty)

/** The share key of `child` within `dag`; a DAG it cannot key is refused. */
const keyOf = (dag: RelDag, child: RelNode): string => {
	const key = shareKey(dag, child)
	if (!key.ok) {
		throw new Refusal(key.error)
	}
	return key.value
}

/** The share groups of statements all sent, in flight order: each key's first statement is its group's feeder. */
const groupsOf = (dag: RelDag, sent: ReadonlyArray<SentSibling>): Map<string, ShareGroup> => {
	const groups = new Map<string, ShareGroup>()
	for (const sibling of sent) {
		const key = keyOf(dag, sibling.child)
		if (!groups.has(key)) {
			groups.set(key, { feeder: sibling.rows, statement: sibling.statement })
		}
	}
	return groups
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
 * otherwise it is sent, and the first of its group. A share key is read only where it can decide: under parent rows
 * where a statement has an earlier one's text and parameters (Siblings).
 */
export const arrivalsOf = <S extends ConservativeStatement>(
	dag: RelDag,
	roots: StatementRoots<S>
): Result.Result<StatementRoots<S & { readonly arrival: Arrival }>, CompileError> =>
	catchRefusal(() => {
		let answers = 0
		const send = (): Sent => ({ kind: "sent", answer: answers++ })
		const siblings = new Map<Sent, Siblings>()
		const keyed = (parent: Sent, held: Siblings): Map<string, ShareGroup> => {
			if (held.kind === "keyed") {
				return held.groups
			}
			const groups = groupsOf(dag, held.sent)
			siblings.set(parent, { kind: "keyed", groups })
			return groups
		}
		const arrivalUnder = (parent: Sent, statement: S, child: RelNode): Arrival => {
			const held = siblings.get(parent) ?? { kind: "sent", sent: [] }
			siblings.set(parent, held)
			if (held.kind === "sent" && !held.sent.some((s) => sameStatement(s.statement, statement))) {
				const rows = send()
				held.sent.push({ statement, child, rows })
				return rows
			}
			const groups = keyed(parent, held)
			const key = keyOf(dag, child)
			const group = groups.get(key)
			if (group !== undefined && sameStatement(statement, group.statement)) {
				return { kind: "fed", feeder: group.feeder }
			}
			const rows = send()
			if (group === undefined) {
				groups.set(key, { feeder: rows, statement })
			}
			return rows
		}
		const attached = (
			tree: AttachedTree<S>,
			parent: Sent
		): AttachedTree<S & { readonly arrival: Arrival }> => {
			const arrival = arrivalUnder(parent, tree.statement, tree.attach.child)
			const rows = arrival.kind === "fed" ? arrival.feeder : arrival
			return {
				statement: { ...tree.statement, arrival },
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
