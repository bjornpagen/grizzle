/**
 * The types of a query's records (program/records.ts): the relations that hold the rows a query found, each column the
 * query's own field, and the query that reads them back, whose rows are the query's own (HeadOf<Q>).
 *
 * A records value is generic over what it holds of its query, never over the query: its rows' type, its read-back
 * rows' type and its root relation's fields, each read off the query once where records(...) is called (RecordFields,
 * HeadOf, ImmediateHeadOf), so no type holding it keeps the query, whose level would be instantiated again wherever
 * the records are (types/derived/derived.ts DefinitionView states the same rule for a derived relation).
 */
import type { AdditionIn } from "#compiler/types/changeset/changeset.ts"
import type {
	Carrier,
	Carriers,
	LiteralOrigin,
	ParamType,
	PhantomOf,
	Simplify,
	UnionToIntersection
} from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { Field, FieldBase } from "#compiler/types/fields/field.ts"
import type {
	ArmOf,
	Decoders,
	HeadOf,
	ImmediateHeadOf,
	Query
} from "#compiler/types/query/query.ts"
import type { Fact, Relation } from "#compiler/types/schema/relation.ts"

/**
 * Whether a head carrier is one head literal's, which its records store nowhere, their read writing it again; head
 * literals of several values at one key, a union's, are a column (program/records.ts literalsField).
 */
type IsHeadLiteral<C> =
	PhantomOf<C> extends { readonly origin: LiteralOrigin } ? IsOneValue<HostOfCarrier<C>> : false

/** The values a carrier delivers, its column's host type. */
type HostOfCarrier<C> = C extends Carrier<infer A> ? A : never

/** Whether a literal type is one value: no union of values, as `boolean` is of true and false. */
type IsOneValue<A> = [A] extends [never]
	? false
	: [A] extends [UnionToIntersection<A>]
		? true
		: false

/**
 * The stored field of a head column: a field of the column's host type, SQL type, domain, facts and language, so a
 * contract's brand, a closed id's handles and a refined text's language are the column's own.
 */
export type StoredField<C> =
	C extends Carrier<infer A, infer S, infer D, infer F, infer L> ? Field<A, S, D, F, L> : never

/** The stored fields of a heading of carriers: each column's stored field, but a head literal's, stored nowhere. */
export type StoredFieldsOf<Hc> = {
	readonly [K in keyof Hc as IsHeadLiteral<Hc[K]> extends true ? never : K]: StoredField<Hc[K]>
}

/** The fields of a query Q's root record relation: the owner's fields, then Q's heading's stored fields. */
export type RecordFields<Owner, Q> = Simplify<Owner & StoredFieldsOf<Q["heading" & keyof Q]>>

/** What records(...) takes as a query: a value the builder made, with its heading of carriers and its decoders. */
export type RecordedQuery = Decoders<unknown, unknown> & { readonly heading: Carriers }

/** What records(...) takes as an owner: a record of field descriptors, each a field of the root's key or payload. */
export type RecordOwner = Readonly<Record<string, FieldBase>>

/**
 * A query's records (schema/records.ts records): its root relation `${Stem}Row`, the owner's fields then the query's
 * stored columns, keyed by the owner's key; the relations and laws a level lists for them, root first; and the query's
 * own decoders, its rows' (Head) and its read-back rows' (IHead), which the read of the records (RecordsQuery)
 * delivers through.
 */
export interface Records<
	Stem extends string,
	Head,
	IHead,
	Fields extends RecordOwner,
	Owner extends RecordOwner,
	Key extends ReadonlyArray<keyof Fields & keyof Owner & string>
> extends Decoders<Head, IHead> {
	readonly kind: "records"
	readonly stem: Stem
	readonly row: Relation<`${Stem}Row`, Fields, readonly [...Key]>
	readonly relations: readonly [Relation<`${Stem}Row`, Fields, readonly [...Key]>]
	readonly rules: readonly []
	readonly owner: Owner
	readonly ownerKey: Key
}

/** Any query's records. */
export type AnyRecords = Records<
	string,
	unknown,
	unknown,
	RecordOwner,
	RecordOwner,
	ReadonlyArray<string>
>

/** A parameter of an owner's key field: the field's domain, SQL type and host type, as r.param of it takes them. */
type OwnerParam<F> =
	F extends Field<infer H, infer S, infer D, infer _F, infer _L> ? ParamType<D, S, H> : never

/** The parameters of the read of records R: one per field of the owner's key, under the field's name. */
export type OwnerParams<R extends AnyRecords> = Simplify<{
	readonly [K in R["ownerKey"][number]]: OwnerParam<R["owner"][K]>
}>

/**
 * The read of records R over the level L that lists them (schema/records.ts recordsQuery): the rows stored at one
 * value of the owner's key, its parameters, each delivered through R's decoders, the query's own, so its rows are the
 * query's, HeadOf<Q>, under either reading. It reads no context, and its evidence is unknown.
 */
export type RecordsQuery<L, R extends AnyRecords> = Query<
	L,
	HeadOf<R>,
	Evidence.Unknown,
	OwnerParams<R>,
	ImmediateHeadOf<R>,
	Carriers,
	never,
	readonly [ArmOf<HeadOf<R>, Carriers>]
>

/** The owner's values as the caller states them for records R: a value of each owner field. */
export type OwnerFacts<R extends AnyRecords> = Fact<{ readonly fields: R["owner"] }>

/**
 * What an insert of found rows into records R, which the level L lists, writes, as ChangeSet.insertAll takes it: under
 * the root's name its additions in L (AdditionIn), each a row's owner's values then its stored columns.
 */
export type RecordsInsert<L, R extends AnyRecords> = {
	readonly [N in R["row"]["name"]]: ReadonlyArray<AdditionIn<L, R["row"]>>
}
