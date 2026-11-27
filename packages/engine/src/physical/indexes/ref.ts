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
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { nominal } from "#compiler/core/brand.ts"
import type { IndexMethod } from "#compiler/core/identity.ts"
import type { LawIndexKey } from "#compiler/ir/law.ts"
import { type IndexRequest, indexOpclassText } from "#compiler/ir/products.ts"
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
export type IndexResolver = (request: IndexRequest) => IndexRef

/**
 * An access request's content, every field of it, as a resolution keys it: equal requests, however many statements
 * make them, land on one index (the plan is a function of what requests ask), so a request resolves by what it asks,
 * never by which object asked it.
 */
export type RequestContent = ReadonlyArray<string | number>

/** A law key's column as its content holds it: a field's name, a law column's identifier, or a suffix key's. */
const lawKeyText = (k: LawIndexKey): string => {
	const c = k.column
	switch (c.kind) {
		case "field":
			return c.field.name
		case "law":
			return c.column
		case "suffix":
			return `suffix(${c.of.field.name})`
	}
}

/**
 * The content of `r` (`RequestContent`): an access request's relation, method, use, fixed count, and each key's
 * expression, direction and class; a law's maintenance request's relation, method, use, and each block's keys, each
 * its column, direction and class, a block's end marked, so two blockings of one key list differ.
 */
export const requestContent = (r: IndexRequest): RequestContent =>
	r.role === "access"
		? [
				r.relation,
				r.method,
				r.use,
				r.fixed,
				...r.keys.flatMap((k) => [String(k.expr), k.dir, indexOpclassText(k.opclass) ?? ""])
			]
		: [
				r.relation,
				r.method,
				r.use,
				r.role,
				...r.blocks.flatMap((block) => [
					...block.flatMap((k) => [lawKeyText(k), k.dir, indexOpclassText(k.opclass) ?? ""]),
					block.length
				])
			]

/**
 * The index each planned access request resolved to, as data (physical/indexes/engine.ts planIndexes): each request's
 * content, its relation as installed, with the IndexRef it landed on, each content once, in the plan's order. The fact
 * the installation's snapshot records (deploy/snapshot/types.ts SnapshotDerived `resolved`), so a served compile from
 * the snapshot alone resolves every read as generate's did, the one resolver of both (`resolverOf`).
 */
export type IndexResolutions = ReadonlyArray<{
	readonly request: RequestContent
	readonly index: IndexRef
}>

/**
 * The resolver of `resolutions`, each request's relation read as it is installed (`installedAs`, analysis/schema.ts
 * CheckedSchema installedAs): a request they hold no resolution of is one the installation's indexes were not planned
 * from, the asker's internal compiler error, never an index guessed.
 */
export const resolverOf = (
	resolutions: IndexResolutions,
	installedAs: (relation: string) => string
): IndexResolver => {
	const resolved = new TupleMap<RequestContent, IndexRef>()
	for (const r of resolutions) {
		resolved.set(r.request, r.index)
	}
	return (request) =>
		resolved.get(requestContent({ ...request, relation: installedAs(request.relation) })) ??
		defect(
			`a missed index: the ${request.use} of ${request.relation} is no request the installation's indexes were planned from`
		)
}
