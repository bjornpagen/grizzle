/**
 * A reference to an index the installation holds, as a plan names it (sql/plan.ts ReadPlan, sql/advice.ts printAdvice):
 * its schema-qualified name, which advice prints; its access method; the installed columns it stores as themselves, in
 * key order, an expression key storing none, which an index-only scan's cover is judged by; and whether its access
 * method returns the values it stores (amcanreturn: a B-tree does, and a GiST index of an operator class with a fetch
 * function; GIN and HNSW never), without which no scan of it is index-only.
 *
 * An IndexRef is minted only by the index engine (physical/indexes/engine.ts planIndexes), once it has planned the index
 * a request resolves to, or a key's or a stored derived relation's unique index that serves it: a read the engine never
 * resolved has none, so no plan can name an index the installation does not hold. A request no index serves is the
 * engine's internal compiler error (README "Keys and indexes"), never a resolver's: the resolver is total over the
 * requests it was planned from.
 */
import { nominal } from "#compiler/core/brand.ts"
import type { IndexMethod } from "#compiler/core/identity.ts"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"

declare const indexRefBrand: unique symbol

/** What an IndexRef states of its index (see the header). */
interface IndexFacts {
	readonly name: ObjectName
	readonly method: IndexMethod
	readonly stores: ReadonlyArray<string>
	readonly returns: boolean
}

/** An index the installation holds, as a plan names it (see the header). */
export type IndexRef = IndexFacts & { readonly [indexRefBrand]: true }

/** The IndexRef of an index the engine planned or found serving a request: physical/indexes/engine.ts's alone. */
export const indexRef = nominal<IndexFacts, IndexRef>()

/**
 * The index each request of an installation resolves to (physical/indexes/engine.ts planIndexes): total over the
 * requests the plan was made from, every one served by construction of the plan.
 */
export type IndexResolver = (request: AccessIndexRequest) => IndexRef
