/**
 * The types of a query's records (schema/records.ts): the relations that hold the rows a query found, each column the
 * query's own field, and the query that reads them back, whose rows are the query's own (HeadOf<Q>).
 *
 * A records value is generic over what it holds of its query, never over the query: its rows' type, its read-back
 * rows' type and its root relation's fields, each read off the query once where records(...) is called (RecordFields,
 * HeadOf, ImmediateHeadOf), so no type holding it keeps the query, whose level would be instantiated again wherever
 * the records are (types/derived/derived.ts DefinitionView states the same rule for a derived relation).
 *
 * The relations of a query's attachments, at any depth (program/records.ts), are typed off its `attached` phantom
 * (types/query/query.ts Attachment) where records(...) is called:
 * - Each attachment's relation is `${Stem}${Capitalize<name>}`, or its parent relation's name followed by
 *   `Capitalize<name>` where that capitalized name is another attachment's anywhere in the tree, or the root's `Row`
 *   (AttachedName). The rule reads no order, so a record of reads, whose attachments no type orders, names them as a
 *   chain of attach calls does.
 * - Its fields: its parent's key, each field under its parent's name unless the child's own columns or attachments take
 *   it, then under the first of `<name>2`, `<name>3`, … none takes (Fresh); for an array, its place `at`, fresh the same
 *   way, its ordered family's drawn index; the child's stored columns (StoredFieldsOf); and a drawn count under the
 *   name of each array attachment of its own (CountFields). Its key: the carried fields, then its place.
 * - Its law over its parent: an array is the ordered family of its parent's count at the attachment's name; an option
 *   is contained in its parent; one mirrors its parent; an arm is the relation of its handle in the alternatives law
 *   over its parent's discriminator field, one law per field.
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
import type { DrawnField, Field, FieldBase } from "#compiler/types/fields/field.ts"
import type {
	Arm,
	ArmOf,
	AttachedOf,
	Decoders,
	HeadOf,
	ImmediateHeadOf,
	Query
} from "#compiler/types/query/query.ts"
import type { AnyRoster, Fact, Relation } from "#compiler/types/schema/relation.ts"
import type {
	Alternatives,
	Containment,
	Fin,
	Mirrors,
	OrderedFamily,
	Side
} from "#compiler/types/schema/statements.ts"

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

/**
 * The fields of a query Q's root record relation: the owner's fields, then Q's heading's stored fields, then the drawn
 * count of each array attachment of Q's, under the attachment's name (CountFields).
 */
export type RecordFields<Owner, Q> = Simplify<
	Owner & StoredFieldsOf<Q["heading" & keyof Q]> & CountFields<AttachedOf<Q>>
>

/** The root relation of records of the stem Stem over the fields Fields, keyed by Key. */
export type RecordsRow<
	Stem extends string,
	Fields,
	Key extends ReadonlyArray<keyof Fields & string>
> = Relation<`${Stem}Row`, Fields, Key>

/**
 * The relations of a query Q's attachments, at any depth, under the root of records of the stem Stem, the owner Owner
 * and its key Key (AttachedRelations): what records(...) reads off Q's `attached` phantom once.
 */
export type RecordChildren<Stem extends string, Owner, Key, Q> = AttachedRelations<
	Stem,
	RecordsPaths<AttachedOf<Q>>,
	RootOf<Stem, Owner, Key, Q>,
	AttachedOf<Q>
>

/** The laws of a query Q's attachments, at any depth (AttachedLaws). */
export type RecordLaws<Stem extends string, Owner, Key, Q> = AttachedLaws<
	Stem,
	RecordsPaths<AttachedOf<Q>>,
	RootOf<Stem, Owner, Key, Q>,
	AttachedOf<Q>
>

/** The relations of Q's attachments an insert states apart from the root (ApartRelations). */
export type RecordApart<Stem extends string, Owner, Key, Q> = ApartRelations<
	Stem,
	RecordsPaths<AttachedOf<Q>>,
	RootOf<Stem, Owner, Key, Q>,
	AttachedOf<Q>
>

/** The root of records of Q as its attachments read it: Records' own `row`. */
type RootOf<Stem extends string, Owner, Key, Q> =
	Key extends ReadonlyArray<keyof RecordFields<Owner, Q> & string>
		? RecordsRow<Stem, RecordFields<Owner, Q>, Key>
		: never

/** What records(...) takes as a query: a value the builder made, with its heading of carriers and its decoders. */
export type RecordedQuery = Decoders<unknown, unknown> & { readonly heading: Carriers }

/** What records(...) takes as an owner: a record of field descriptors, each a field of the root's key or payload. */
export type RecordOwner = Readonly<Record<string, FieldBase>>

/**
 * A query's records (program/records.ts records): its root relation `${Stem}Row`, the owner's fields then the query's
 * stored columns and its arrays' counts, keyed by the owner's key; the relations and laws a level lists for them, root
 * first, then each attachment's (Children, Laws); the relations an insert states apart from the root (Apart); and the
 * query's own decoders, its rows' (Head) and its read-back rows' (IHead), which the read of the records (RecordsQuery)
 * delivers through.
 */
export interface Records<
	Stem extends string,
	Head,
	IHead,
	Fields extends RecordOwner,
	Owner extends RecordOwner,
	Key extends ReadonlyArray<keyof Fields & keyof Owner & string>,
	Children = never,
	Laws = never,
	Apart = never
> extends Decoders<Head, IHead> {
	readonly kind: "records"
	readonly stem: Stem
	readonly row: RecordsRow<Stem, Fields, Key>
	readonly relations: readonly [RecordsRow<Stem, Fields, Key>, ...ReadonlyArray<Children>]
	readonly rules: ReadonlyArray<Laws>
	readonly apart: ReadonlyArray<Apart>
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
	ReadonlyArray<string>,
	unknown,
	unknown,
	RecordsRelation
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
 * What an insert of found rows, each beside its owner's values, into records R, which the level L lists, writes, as
 * ChangeSet.insertAll takes it: under the root's name and each apart relation's (Records' Apart), its additions in L
 * (AdditionIn), the root's each its owner's values then a row's stored columns, each array's members nested at its
 * count.
 */
export type RecordsInsert<L, R extends AnyRecords> = {
	readonly [Rel in R["row"] | R["apart"][number] as Rel["name"]]: ReadonlyArray<AdditionIn<L, Rel>>
}

/** A relation that holds records, as the attachments under it read it: its name, its fields and its key, in order. */
export type RecordsRelation = Relation<
	string,
	Readonly<Record<string, FieldBase>>,
	ReadonlyArray<string>
>

/**
 * A relation that holds records as the types of the attachments under it read it: its name, its fields and its key, in
 * order.
 */
interface RecordsParent {
	readonly name: string
	readonly fields: unknown
	readonly primaryKey: ReadonlyArray<string>
}

/** An attachment's members, read by key: its delivery, its child's carriers and its child's attachments. */
type DeliveryOf<A> = A["delivery" & keyof A]
type CarriersOf<A> = A["carriers" & keyof A]
type ChildrenOf<A> = A["attached" & keyof A]

/** The drawn count of each array attachment of At, under the attachment's name: the field its ordered family counts. */
type CountFields<At> = {
	readonly [N in keyof At & string as DeliveryOf<At[N]> extends "array" ? N : never]: DrawnField
}

/**
 * The paths of the capitalized names of the attachments of At, at any depth, each segment after `Prefix`: `Items` at
 * the top, `Items.Notes` under it. A name holds no `.`, which no declared name holds.
 */
type NamePaths<At, Prefix extends string> = {
	[N in keyof At & string]:
		| `${Prefix}${Capitalize<N>}`
		| NamePaths<ChildrenOf<At[N]>, `${Prefix}${Capitalize<N>}.`>
}[keyof At & string]

/**
 * The paths of a query's attachments with the root's own, `.Row`, a path no attachment's is that ends in `Row`: what an
 * attachment's relation name must not repeat.
 */
type RecordsPaths<At> = ".Row" | NamePaths<At, "">

/** Whether X is a union of several members. */
type IsUnion<X, All = X> = X extends unknown ? ([All] extends [X] ? false : true) : never

/** Whether the capitalized name C ends more than one of the paths. */
type Repeats<Paths, C extends string> = IsUnion<Extract<Paths, C | `${string}.${C}`>>

/**
 * The name of the relation of the attachment named N under the relation named Parent: `${Stem}${Capitalize<N>}`, or
 * `${Parent}${Capitalize<N>}` where another path ends in its capitalized name.
 */
type AttachedName<Stem extends string, Paths, Parent extends string, N extends string> =
	true extends Repeats<Paths, Capitalize<N>>
		? `${Parent}${Capitalize<N>}`
		: `${Stem}${Capitalize<N>}`

/**
 * The first of B, `${B}2`, `${B}3`, … that Taken does not hold: Count's length is the suffix tried, its first try B
 * itself.
 */
type Fresh<B extends string, Taken, Count extends ReadonlyArray<unknown> = readonly [unknown]> = (
	Count extends readonly [unknown] ? B : `${B}${Count["length"]}`
) extends infer C extends string
	? C extends Taken
		? Fresh<B, Taken, readonly [...Count, unknown]>
		: C
	: never

/** The names a child relation carries its parent's key under, in order, each fresh beside Taken and the ones before it. */
type CarriedNames<
	Key extends ReadonlyArray<string>,
	Taken,
	Out extends ReadonlyArray<string> = readonly []
> = Key extends readonly [infer K extends string, ...infer Rest extends ReadonlyArray<string>]
	? CarriedNames<Rest, Taken | Fresh<K, Taken>, readonly [...Out, Fresh<K, Taken>]>
	: Out

/** A field of the parent's key as its child carries it: a place, drawn in the parent, is a natural the child states. */
type Carry<F> = F extends DrawnField<infer B> ? B : F

/** The child's fields that carry its parent's key: each key field of P's under its carried name (CarriedNames). */
type CarriedFields<P extends RecordsParent, Names extends ReadonlyArray<string>> = {
	readonly [I in keyof Names & `${number}` as Names[I] & string]: Carry<
		P["fields"][P["primaryKey"][I & keyof P["primaryKey"]] & keyof P["fields"]]
	>
}

/** The names a child's own records take: its columns and its attachments. */
type TakenBy<A> = keyof CarriersOf<A> | keyof ChildrenOf<A>

/** The carried names of the child A under P. */
type CarriedOf<P extends RecordsParent, A> = CarriedNames<P["primaryKey"], TakenBy<A>>

/** The place of an array child A under P: `at`, fresh beside its columns, attachments and carried names. */
type PlaceOf<P extends RecordsParent, A> = Fresh<"at", TakenBy<A> | CarriedOf<P, A>[number]>

/** The key of the child A under P: its carried names, then, for an array, its place. */
type ChildKey<P extends RecordsParent, A> =
	DeliveryOf<A> extends "array" ? readonly [...CarriedOf<P, A>, PlaceOf<P, A>] : CarriedOf<P, A>

/** The place field of an array child A under P, drawn by its ordered family; none for any other child. */
type PlaceField<P extends RecordsParent, A> =
	DeliveryOf<A> extends "array" ? { readonly [K in PlaceOf<P, A>]: DrawnField } : unknown

/** The fields of the child A under P: its carried key, its place, its stored columns and its arrays' counts. */
type ChildFields<P extends RecordsParent, A> = Simplify<
	CarriedFields<P, CarriedOf<P, A>> &
		PlaceField<P, A> &
		StoredFieldsOf<CarriersOf<A>> &
		CountFields<ChildrenOf<A>>
>

/** The relation of the attachment A named N under P. */
type ChildRelation<Stem extends string, Paths, P extends RecordsParent, N extends string, A> =
	ChildKey<P, A> extends infer K extends ReadonlyArray<keyof ChildFields<P, A> & string>
		? Relation<AttachedName<Stem, Paths, P["name"], N>, ChildFields<P, A>, K>
		: never

/**
 * The relations of the attachments At under P, at any depth: each attachment's own (ChildRelation), and those under
 * it.
 */
type AttachedRelations<Stem extends string, Paths, P extends RecordsParent, At> = {
	[N in keyof At & string]:
		| ChildRelation<Stem, Paths, P, N, At[N]>
		| AttachedRelations<Stem, Paths, ChildRelation<Stem, Paths, P, N, At[N]>, ChildrenOf<At[N]>>
}[keyof At & string]

/**
 * The relations of the attachments At under P, at any depth, that an insert states apart from their parent: every
 * child but an array's, whose members an insert nests under their owner's count (types/changeset AdditionIn).
 */
type ApartRelations<Stem extends string, Paths, P extends RecordsParent, At> = {
	[N in keyof At & string]:
		| (DeliveryOf<At[N]> extends "array" ? never : ChildRelation<Stem, Paths, P, N, At[N]>)
		| ApartRelations<Stem, Paths, ChildRelation<Stem, Paths, P, N, At[N]>, ChildrenOf<At[N]>>
}[keyof At & string]

/** The law of the child relation C of a delivery D under P named N: its family, containment or mirror of P. */
type DeliveryLaw<
	D,
	P extends RecordsParent,
	N extends string,
	C extends RecordsParent
> = D extends "array"
	? OrderedFamily<Side<C, C["primaryKey"]>, Fin<P, N>>
	: D extends "option"
		? Containment<Side<C, C["primaryKey"]>, Side<P, P["primaryKey"]>>
		: D extends "one"
			? Mirrors<Side<C, C["primaryKey"]>, Side<P, P["primaryKey"]>>
			: never

/** The arm attachments of At over the parent's field F. */
type ArmsOver<At, F extends string> = {
	[N in keyof At & string]: DeliveryOf<At[N]> extends Arm<"arm", F, string> ? N : never
}[keyof At & string]

/** The parent's fields At's arm attachments discriminate by. */
type ArmFields<At> = {
	[N in keyof At & string]: DeliveryOf<At[N]> extends Arm<"arm", infer F extends string, string>
		? F
		: never
}[keyof At & string]

/** The handle an arm attachment's records are held at. */
type HandleOfArm<A> = DeliveryOf<A> extends Arm<"arm", string, infer Hd extends string> ? Hd : never

/**
 * The alternatives laws over P of its arm attachments At, one per discriminator field, each arm the child relation of
 * its handle.
 */
type ArmLaws<Stem extends string, Paths, P extends RecordsParent, At> = {
	[F in ArmFields<At>]: Alternatives<
		P,
		F,
		AnyRoster,
		{
			readonly [N in ArmsOver<At, F> as HandleOfArm<At[N]>]: ChildRelation<Stem, Paths, P, N, At[N]>
		}
	>
}[ArmFields<At>]

/** The laws of the attachments At under P, at any depth: each child's over its parent, and the arms' by field. */
type AttachedLaws<Stem extends string, Paths, P extends RecordsParent, At> =
	| ArmLaws<Stem, Paths, P, At>
	| {
			[N in keyof At & string]:
				| DeliveryLaw<DeliveryOf<At[N]>, P, N, ChildRelation<Stem, Paths, P, N, At[N]>>
				| AttachedLaws<Stem, Paths, ChildRelation<Stem, Paths, P, N, At[N]>, ChildrenOf<At[N]>>
	  }[keyof At & string]
