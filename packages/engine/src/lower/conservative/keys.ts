/**
 * What a delivery's rows prove of their keys, which an attachment's parent key set reads in place of deduplicating
 * (deliver.ts keysOf).
 *
 * The physical analysis keys a node's rows within one evaluation (ShapeFacts keyedBy, an Identification). A node that
 * reads an enclosing node is evaluated once per binding of what it reads, so its key holds within each binding, and the
 * rows a part delivers under every parent at once are the union of those evaluations. A DeliveredKey is a key of that
 * union, minted only where one evaluation's key holds across all of them (`AcrossEvaluations`), so a key of one
 * evaluation never stands where a key of the delivered rows is required.
 */
import type { Identification } from "#compiler/analysis/physical/fds.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { OuterRefs } from "#compiler/ir/dag.ts"
import type { Heading, KeySet, NodeOf } from "#compiler/ir/rel.ts"

/** A ParentFixed's content: the child columns the correlation equates with the parent key's, one per parent key column. */
interface ParentFixedOf {
	readonly correlated: KeySet
}

declare const parentFixedBrand: unique symbol

/**
 * The proof that a child of an attachment fixes its parent key: the correlation equates every parent key column with a
 * child column, so a child under two parent keys would hold two values of one column. The rows of an attachment are
 * then a set of children alone, and two children of one value of the correlated columns are of one parent.
 */
export type ParentFixed = ParentFixedOf & { readonly [parentFixedBrand]: true }

const ParentFixed = nominal<ParentFixedOf, ParentFixed>()

/**
 * Whether the children of `attach` fix their parent key `parentKey`: its proof where every parent key column is one
 * the correlation equates with a child column, and none where the child reads a parent column the correlation does not
 * equate, which leaves one child under more than one parent key.
 */
export const parentFixed = (
	attach: NodeOf<"Attach">,
	parentKey: Heading
): ParentFixed | undefined => {
	const correlated: Array<string> = []
	for (const k of parentKey) {
		const pair = attach.correlation.find((c) => c.parent === k.name)
		if (pair === undefined) {
			return undefined
		}
		correlated.push(pair.child)
	}
	return ParentFixed({ correlated })
}

/**
 * Why a key of one evaluation of a node holds of every row a part delivers: the node is evaluated once, since it reads
 * nothing of an enclosing node; or the key's columns hold the child's correlated columns, which fix its parent key
 * (`ParentFixed`), so rows of two evaluations differ there.
 */
export type AcrossEvaluations =
	| { readonly kind: "evaluatedOnce" }
	| { readonly kind: "parentFixed"; readonly fixed: ParentFixed }

interface DeliveredKeyOf {
	readonly columns: KeySet
	/** The physical analysis's key of one evaluation of the node over `columns`. */
	readonly within: Identification
	readonly across: AcrossEvaluations
}

declare const deliveredKeyBrand: unique symbol

/** A key of every row a part delivers: at most one row per value of `columns` (see the header). */
export type DeliveredKey = DeliveredKeyOf & { readonly [deliveredKeyBrand]: true }

const DeliveredKey = nominal<DeliveredKeyOf, DeliveredKey>()

/** A key set of delivered rows: a set by a DeliveredKey of the rows, read as it is, or unproved, and deduplicated. */
export type KeySetProof =
	| { readonly kind: "proved"; readonly key: DeliveredKey }
	| { readonly kind: "unproved" }

const unproved: KeySetProof = Object.freeze({ kind: "unproved" })

/** What delivered rows prove of the columns a key set reads. */
export type RowKeys = (columns: KeySet) => KeySetProof

/** What the conservative baseline proves of any rows: nothing, so each of its key sets deduplicates. */
export const noRowKeys: RowKeys = () => unproved

/**
 * The key set over `columns` of the rows a part delivers of a node: proved where the physical analysis keys one
 * evaluation of the node by them (`within`) and that key holds across evaluations, because the node reads nothing of an
 * enclosing node (`outer` is empty) or because `columns` hold the correlated columns of a child that fixes its parent
 * key (`fixed`); unproved otherwise.
 */
export const keySetOf = (
	columns: KeySet,
	within: Identification | undefined,
	outer: OuterRefs,
	fixed: ParentFixed | undefined
): KeySetProof => {
	if (within === undefined) {
		return unproved
	}
	if (outer.size === 0) {
		return {
			kind: "proved",
			key: DeliveredKey({ columns, within, across: { kind: "evaluatedOnce" } })
		}
	}
	if (fixed !== undefined && fixed.correlated.every((c) => columns.includes(c))) {
		return {
			kind: "proved",
			key: DeliveredKey({ columns, within, across: { kind: "parentFixed", fixed } })
		}
	}
	return unproved
}
