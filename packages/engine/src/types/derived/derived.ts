import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { Built, Phantom } from "#compiler/core/phantom.ts"
import type { DerivedStorage } from "#compiler/ir/desc.ts"
import type { Carriers, Headed, Refusal } from "#compiler/types/core/phantom.ts"
import type {
	ContextsOf,
	HeadOf,
	ParamsOf,
	QueryBase,
	UnionArm,
	UnionArms
} from "#compiler/types/query/query.ts"
import type { Aggregate, Producer } from "#compiler/types/query/terms.ts"
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

declare const ruleRead: unique symbol

/**
 * Whether a rule may read a derived relation, a phantom of its definition (RuleReadOf): `true`, or the refusals of the
 * arms a rule cannot read. on, select and check take a derived relation that is RuleReadDerived, so one of another
 * definition is refused where its side is written, the refusal named at this member.
 */
export interface RuleRead<out R> {
	readonly [ruleRead]?: R | undefined
}

/**
 * The refusal of a definition's arm a rule cannot read, or never for an arm that joins, selects and projects: a rule or
 * a union of rules, no head term an aggregate or a span producer (analysis/theory/query.ts, UnsupportedLawFamily).
 */
type ArmRefusal<A> =
	A extends UnionArm<infer C, PropertyKey, infer Stage, boolean>
		? Stage extends "rule" | "union"
			? [KeysOfCarrier<C, Aggregate<unknown, never>>] extends [never]
				? [KeysOfCarrier<C, Producer<unknown, never>>] extends [never]
					? never
					: Refusal<"a rule reads a derived relation whose definition joins, selects and projects: this one produces spans">
				: Refusal<"a rule reads a derived relation whose definition joins, selects and projects: this one aggregates">
			: Refusal<StageRefusals[Exclude<Stage, "rule" | "union">]>
		: never

/** The refusal of a definition's arm a stage beyond a rule made. */
interface StageRefusals {
	readonly take: "a rule reads a derived relation whose definition joins, selects and projects: this one orders and takes"
	readonly attach: "a rule reads a derived relation whose definition joins, selects and projects: this one attaches a nested query"
	readonly approximate: "a rule reads a derived relation whose definition joins, selects and projects: this one approximates a search"
	readonly recursive: "a rule reads a derived relation whose definition joins, selects and projects: this one recurses"
}

/** The fields of a heading of carriers whose terms are of kind X. */
type KeysOfCarrier<C, X> = {
	readonly [K in keyof C]-?: [C[K]] extends [never] ? never : C[K] extends X ? K : never
}[keyof C]

/** The refusals of the arms of Q's definition, or never where every arm joins, selects and projects. */
type ArmsRefusals<Q> =
	Q extends Phantom<infer B>
		? B extends { readonly arms: infer Arms extends UnionArms }
			? ArmRefusal<Arms[number]>
			: never
		: never

/** Whether a rule may read a derived relation over the definition Q: `true`, or its arms' refusals (RuleRead). */
export type RuleReadOf<Q> = [ArmsRefusals<Q>] extends [never] ? true : ArmsRefusals<Q>

/** A derived relation a rule may read: one whose definition joins, selects and projects (RuleRead). */
export type RuleReadDerived = AnyDerived & RuleRead<true>

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
	extends AnyDerived, Phantom<{ readonly fields: Q["heading"] }>, RuleRead<RuleReadOf<Q>> {
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
