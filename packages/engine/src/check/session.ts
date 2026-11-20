import type { ResolvedQuery } from "#compiler/check/params.ts"
import type { Inferred, Located, QueryDesc } from "#compiler/ir/desc.ts"
import type { RelNode } from "#compiler/ir/rel.ts"

/**
 * What the checks of one compile share, owned by that compile and passed to every check it runs, never held by a
 * module: a ChangeSet's members, read-backs and fills (write/frontend/compile.ts), or the one query of a query's
 * compile.
 *
 * - Each imported query resolved once (check/params.ts resolveQuery): an imported query is its own namespace, so its
 *   resolution is the query's alone, and one resolution of it serves every import of it in every query the compile
 *   checks, whose imports of one query then share one resolved query.
 * - The place of each object an import's key names (check/checker.ts importedKey), in the order the checks met it.
 * - Each closed import the checks built, by its key: an import bound to parameters and constants alone reads the same
 *   rows wherever it stands in the compile's queries, whose parameters are one namespace, so a write's DAG merges the
 *   imports of one key as one node (write/frontend/dag.ts QueryMerger).
 */
export class CheckSession {
	/** Each imported query, resolved. */
	readonly resolved = new WeakMap<QueryDesc<Located, Inferred>, ResolvedQuery>()
	readonly #places = new WeakMap<object, number>()
	#placed = 0
	readonly #closed = new WeakMap<RelNode, string>()

	/** `o`'s place among the objects import keys name. */
	place(o: object): number {
		const known = this.#places.get(o)
		if (known !== undefined) {
			return known
		}
		const place = this.#placed
		this.#placed += 1
		this.#places.set(o, place)
		return place
	}

	/** Records `node`, a node of a checked query's DAG, as the closed import of `key`. */
	closed(node: RelNode, key: string): void {
		this.#closed.set(node, key)
	}

	/** The key `node` was built under as a closed import, none for any other node. */
	closedKey(node: RelNode): string | undefined {
		return this.#closed.get(node)
	}
}
