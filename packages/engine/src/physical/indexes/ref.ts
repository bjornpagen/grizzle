/**
 * A reference to an index the installation holds, as a plan names it (sql/plan.ts ReadPlan, sql/advice.ts printAdvice):
 * its schema-qualified name, which advice prints; its access method; the installed columns it stores as themselves, in
 * key order, an expression key storing none, which an index-only scan's cover is judged by; and whether its access
 * method returns the values it stores (amcanreturn: a B-tree does, and a GiST index of an operator class with a fetch
 * function; GIN and HNSW never), without which no scan of it is index-only.
 *
 * An IndexRef is minted only by the index engine (physical/indexes/engine.ts planIndexes), for each index the
 * installation holds, a key's, a stored derived relation's unique index or one it created, and a read resolves to the one
 * the coverage rule lands it on (engine.ts resolverOf), so no plan can name an index the installation does not hold. A
 * read no index serves is a missed index, the internal compiler error of whatever compile asked it (docs/limits.md "Keys and
 * indexes").
 */
import { nominal } from "#compiler/core/brand.ts"
import type { IndexMethod } from "#compiler/core/identity.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
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
 * The index each request of an installation resolves to (physical/indexes/engine.ts resolverOf): the one its coverage
 * rule lands it on among the installation's indexes, a request no index of them serves its asker's internal compiler
 * error.
 */
export type IndexResolver = (request: IndexRequest) => IndexRef

/**
 * The index each request lands on among an installation's indexes (physical/indexes/engine.ts servingOf), none where no
 * index of them serves it: the partial form of IndexResolver, what a read no index planning planned for reads through.
 */
export type IndexServing = (request: IndexRequest) => IndexRef | undefined
