import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { Built, Phantom } from "#compiler/core/phantom.ts"
import type { DerivedStorage } from "#compiler/ir/desc.ts"
import type { Carriers, Headed, Refusal } from "#compiler/types/core/phantom.ts"
import type { ContextsOf, HeadOf, ParamsOf, QueryBase } from "#compiler/types/query/query.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"

/** A definition: a query holding its heading of carriers. */
export type DefinitionQuery = QueryBase & Headed<Carriers>

/** Any derived relation: the members every one has. */
export interface AnyDerived extends Built, Headed<Carriers> {
	readonly kind: "derived"
	readonly name: string
	readonly definition: QueryBase
	readonly storage: DerivedStorage
	readonly fact: RowDecoder<unknown>
}

/** A derived relation PostgreSQL stores as a materialized view, which db.refresh refreshes. */
export interface AnyMaterialized extends AnyDerived {
	readonly storage: "materialized"
}

/**
 * Derived relations: named queries, stored as materialized views where materialized. The runtime constructor is
 * packages/engine/src/schema's, bound to this signature by the public schema barrel.
 *
 * A derived relation's kind is "derived": a key's, a check's and a containment's side may read it (a rule over its
 * definition), every other statement takes ordinary relations alone, and WritableOf excludes it from ChangeSet members. Its keys are the keys its definition's evidence proves (KeysOf, ../schema/schema.ts), and
 * schema.extend accepts it only over a level below the extension that declares it, because Query is invariant in its
 * schema (../schema/schema.ts DerivedAt).
 *
 * Its fields are its definition's heading, the record of carriers v mints variables over: each head term's column and
 * SQL type, a variable's its field's own, contract included, an aggregate's or a computed term's its result's. A view
 * column is never an identity column, and a term carries no serial declaration. The compiler's inference
 * (analysis/derived) of each column's descriptor is exact, and the snapshot records it. Its facts are decoded by
 * `fact`, the record of those carriers (schema/record.ts record), as a relation's are by its fields'.
 *
 * The fields are a phantom, its definition's heading, which RelationFieldsOf reads; the heading is a real member too,
 * which v mints variables over, and `fact` decodes the facts of that heading.
 */
export interface Derived<
	Name extends string,
	Q extends DefinitionQuery,
	St extends DerivedStorage = DerivedStorage
>
	extends AnyDerived, Phantom<{ readonly fields: Q["heading"] }> {
	readonly kind: "derived"
	readonly name: Name
	readonly definition: Q
	readonly heading: Q["heading"]
	readonly storage: St
	readonly fact: RowDecoder<FactOfFields<Q["heading"]>>
}

/** The definition reads no parameter. */
export type NoParams<Q> = keyof ParamsOf<Q> extends never ? Q : never

/** The fields of every arm of a union head, against the fields common to all of them. */
type AnyKeyOf<H> = H extends unknown ? keyof H : never

/**
 * The refusal a view's definition carries: none for a parameterless query of one heading with at least one field. A
 * view stores one heading, since arms of different headings would be several heading groups; arms that differ only in
 * a literal discriminant's value share their fields and are one heading. A role's query entry is checked by it too
 * (types/schema/world.ts).
 */
export type DefinitionShape<Q> =
	NoParams<Q> extends never
		? never
		: [keyof HeadOf<Q>] extends [never]
			? Refusal<"a derived definition has at least one field">
			: [AnyKeyOf<HeadOf<Q>>] extends [keyof HeadOf<Q>]
				? unknown
				: Refusal<"a derived definition has one heading: a materialized view stores one heading group">

/**
 * The refusal a derived definition carries: a view's (DefinitionShape), and any context it reads, since a materialized
 * view holds no session.
 */
export type DefinitionCheck<Q> = [ContextsOf<Q>] extends [never]
	? DefinitionShape<Q>
	: Refusal<"a derived definition reads no context: a materialized view holds no session">

/**
 * A derived relation is a named query: fields from the query's head, keys from its evidence. It is declared in an
 * extension of the schema its definition reads. `derived(name, q)` stores nothing: a query matching it and a rule over
 * it read its definition. `derived.materialized(name, q)` is the same relation stored as a materialized view, which a
 * query reads as of its last refresh; a rule over it still reads its definition.
 */
export type DerivedConstructor = (<const Name extends string, Q extends DefinitionQuery>(
	name: Name,
	definition: Q & DefinitionCheck<Q>
) => Derived<Name, Q, "live">) & {
	readonly materialized: <const Name extends string, Q extends DefinitionQuery>(
		name: Name,
		definition: Q & DefinitionCheck<Q>
	) => Derived<Name, Q, "materialized">
}
