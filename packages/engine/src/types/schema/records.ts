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
 * - Each attachment's relation is the name its author states for its path in the options' names (RecordNames: its
 *   attachment names from the root joined by `.`), or `${Stem}${Capitalize<name>}`, or its parent relation's name
 *   followed by `Capitalize<name>` where that capitalized name is another attachment's anywhere in the tree, or the
 *   root's `Row` (AttachedName), so a parent's stated name leads its children's (NameAt). The rule reads no order, so a
 *   record of reads, whose attachments no type orders, names them as a chain of attach calls does. A name's length is
 *   no rule of the type's, which would read each name a character at a time: a derived name is admitted at any length
 *   and its installed objects hashed (program/records.ts), and a stated one is the engine's to judge as every declared
 *   name is.
 * - Its fields: its parent's key, each field under its parent's name unless the child's own columns or attachments take
 *   it, then under the first of `<name>2`, `<name>3`, … none takes (Fresh); for an array, its place `at`, fresh the same
 *   way, its ordered family's drawn index; the child's stored columns (StoredFieldsOf); and a drawn count under the
 *   name of each array attachment of its own (CountsNamed). Its key: the carried fields, then its place, each a key
 *   field (KeyField) carried down to its children as they are, so each level is typed off the key of the level above
 *   and what its own attachment states, never by reading the relations above it, and is one type for one child
 *   whichever copy of the attachment tree the checker read it from (ChildRelation).
 * - Its law over its parent: an array is the ordered family of its parent's count at the attachment's name; an option
 *   is contained in its parent; one mirrors its parent.
 */
import type { AdditionIn } from "#compiler/types/changeset/changeset.ts"
import type {
	Carrier,
	Carriers,
	IsOneLiteral,
	LiteralOrigin,
	ParamType,
	PhantomOf,
	Refusal,
	Simplify,
	UnionToIntersection,
	ValueOfTerm
} from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { DrawnField, Field, FieldBase } from "#compiler/types/fields/field.ts"
import type {
	ArmOf,
	AttachedOf,
	Decoders,
	HeadOf,
	ImmediateHeadOf,
	Query
} from "#compiler/types/query/query.ts"
import type { Fact, Relation } from "#compiler/types/schema/relation.ts"
import type {
	Containment,
	Fin,
	Mirrors,
	OrderedFamily,
	Side,
	Statement
} from "#compiler/types/schema/statements.ts"

/**
 * Whether a head carrier is one head literal's, which its records store nowhere, their read writing it again; head
 * literals of several values at one key, a union's, are a column (program/records.ts literalsField). Its values are its
 * column's (ValueOfTerm): a head literal's domain and language are its JavaScript default's, `string` for "shelf", which
 * a carrier read whole would widen its values to.
 */
type IsHeadLiteral<C> =
	PhantomOf<C> extends { readonly origin: LiteralOrigin } ? IsOneValue<ValueOfTerm<C>> : false

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
 * count of each array attachment of Q's, under the attachment's name (CountsNamed).
 */
export type RecordFields<Owner, Q> = Simplify<
	Owner & StoredFieldsOf<Q["heading" & keyof Q]> & CountsNamed<ArrayNames<AttachedOf<Q>>>
>

/** The root relation of records of the stem Stem over the fields Fields, keyed by Key. */
export type RecordsRow<
	Stem extends string,
	Fields,
	Key extends ReadonlyArray<keyof Fields & string>
> = Relation<`${Stem}Row`, Fields, Key>

/**
 * The relations of a query Q's attachments, at any depth, under the root of records of the stem Stem, the owner Owner
 * and its key Key (AttachedRelations): what records(...) reads off Q's `attached` phantom once (RecordsHeld).
 */
export type RecordChildren<Stem extends string, Owner, Key, Q, Names> = RecordsHeld<
	Stem,
	Owner,
	Key,
	Q,
	Names
>["children"]

/** The laws of a query Q's attachments, at any depth (AttachedLaws), as RecordsHeld holds them. */
export type RecordLaws<Stem extends string, Owner, Key, Q, Names> = RecordsHeld<
	Stem,
	Owner,
	Key,
	Q,
	Names
>["laws"]

/** The relations of Q's attachments an insert states apart from the root (ApartRelations, RecordsHeld). */
export type RecordApart<Stem extends string, Owner, Key, Q, Names> = RecordsHeld<
	Stem,
	Owner,
	Key,
	Q,
	Names
>["apart"]

/**
 * What records hold of their query's attachments, each a union read only once Q is a query: over a query's type
 * parameter the conditional waits, so no reader of records' generic signature holds a union half made over a tree no
 * recursion ends, which an instantiation for a query would instantiate again, the whole tree (TS2589 at a fragment of
 * nested records and their rules). Members of an interface, so records(...)'s public signature and its builder's read
 * one union for one records' arguments, which two conditional aliases would make twice and relate member by member
 * (TS2589 at records(...) itself).
 *
 * The recursions over the attachment tree (AttachedRelations, AttachedLaws, ApartRelations) each give a union of
 * boxes, each relation or law in a tuple of one, and the union is unboxed here, in a branch no alias names
 * (`U extends readonly [infer X] ? X : never`), so it is made again as its members alone. A union a recursive alias
 * builds carries that alias and its arguments, the query's attachment phantom among them, which holds each attached
 * query whole; the checker relates two such unions by the alias's variance, which it measures by instantiating the
 * recursion over markers, a tree no level ends, and infers through the arguments into the queries: TS2589 where a
 * fragment's statements, a tuple of laws over the records beside the records' laws, are read back
 * (records of a document scan, an array of nodes each with options and arrays under it). Unboxed, the union is its
 * members, each relation and law one type for one child (ChildRelation), related member by member, each by identity.
 * Distributed again without boxes (`U extends unknown ? U : never`), a union maps to itself: the union the recursion
 * made, alias and all.
 */
interface RecordsHeld<Stem extends string, Owner, Key, Q, Names> {
	readonly children: Q extends unknown
		? AttachedRelations<
				Naming<Stem, RecordsPaths<AttachedOf<Q>>, Names>,
				"",
				`${Stem}Row`,
				RootKey<Owner, Key>,
				AttachedOf<Q>
			> extends infer U
			? U extends Boxed<infer X>
				? X
				: never
			: never
		: never
	readonly laws: Q extends unknown
		? AttachedLaws<
				Naming<Stem, RecordsPaths<AttachedOf<Q>>, Names>,
				"",
				RootOf<Stem, Owner, Key, Q>,
				RootKey<Owner, Key>,
				AttachedOf<Q>
			> extends infer U
			? U extends Boxed<infer X>
				? X
				: never
			: never
		: never
	readonly apart: Q extends unknown
		? ApartRelations<
				Naming<Stem, RecordsPaths<AttachedOf<Q>>, Names>,
				"",
				`${Stem}Row`,
				RootKey<Owner, Key>,
				AttachedOf<Q>
			> extends infer U
			? U extends Boxed<infer X>
				? X
				: never
			: never
		: never
}

/**
 * A relation or law of records as the recursions over the attachment tree give it, boxed, so RecordsHeld makes their
 * unions again as their members alone, unboxing each where no alias names the union.
 */
type Boxed<X> = readonly [X]

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
	readonly name: Stem
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

/**
 * The records of a generated schema (public/dynamic.ts records), their stem and stated names known only at run time:
 * what their types keep of them is what any records hold, every relation one of any name, fields and key
 * (RecordsRelation) and every law a statement, so a level lists them as it lists the dynamic door's relations and no
 * typed query reads their fields. Their rows are unknown, as a query known only at run time states none.
 */
export type GeneratedRecords = Records<
	string,
	unknown,
	unknown,
	RecordOwner,
	RecordOwner,
	ReadonlyArray<string>,
	RecordsRelation,
	Statement,
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

/** A relation that holds records as the laws of the attachments under it read it: its name, its fields and its key. */
interface RecordsParent {
	readonly name: string
	readonly fields: unknown
	readonly primaryKey: ReadonlyArray<string>
}

/**
 * A field of the key of a relation that holds records, as the attachments under it carry it: its name there, and its
 * field, an interface, so one name and field are one type wherever they are read. A relation's key is a tuple of these,
 * read once where the relation is typed and handed to its children whole, so a child's fields are typed off its
 * parent's key alone, never by reading its parent's fields, which would read its grandparent's in turn.
 */
interface KeyField<N extends string, F> {
	readonly name: N
	readonly field: F
}

/** Any key field (KeyField). */
type AnyKeyField = KeyField<string, unknown>

/** The root's key as its children carry it: each field of the owner's key Key under its name, the owner's own. */
type RootKey<Owner, Key> = {
	readonly [I in keyof Key]: KeyField<Key[I] & string, Owner[Key[I] & keyof Owner]>
}

/** The names of a relation's key Pairs, in order. */
type PairNames<Pairs> = { readonly [I in keyof Pairs]: (Pairs[I] & AnyKeyField)["name"] }

/** The fields of a relation's key Pairs: each field under its name. */
type PairFields<Pairs> = {
	readonly [I in keyof Pairs & `${number}` as (Pairs[I] & AnyKeyField)["name"]]: (Pairs[I] &
		AnyKeyField)["field"]
}

/** An attachment's members, read by key: its delivery, its child's carriers and its child's attachments. */
type DeliveryOf<A> = A["delivery" & keyof A]
type CarriersOf<A> = A["carriers" & keyof A]
type ChildrenOf<A> = A["attached" & keyof A]

/**
 * The names of the array attachments of At, a union made in a branch no alias names: one union for one set of names,
 * whichever copy of an attachment tree it was read from, so what is typed off it is one type too. A union an alias
 * makes carries the alias and its arguments, the attachment tree, and is one union per copy of it.
 */
type ArrayNames<At> = [At] extends [unknown]
	? { [N in keyof At & string]: DeliveryOf<At[N]> extends "array" ? N : never }[keyof At & string]
	: never

/** The drawn counts under the names Ns: the fields the ordered families of a relation's arrays count. */
type CountsNamed<Ns extends string> = { readonly [N in Ns]: DrawnField }

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

/**
 * The paths of the attachments of At, at any depth, each after `Prefix`: its name at the top, `stimuli.document` under
 * `stimuli`. A name holds no `.`, which no declared name holds. Each level is read once its attachments are known, so
 * over a query's type parameter, where records(...)'s signature constrains its names by these paths, the recursion
 * waits rather than unfolding a tree no level ends.
 */
type AttachmentPaths<At, Prefix extends string> = At extends unknown
	? {
			[N in keyof At & string]:
				| `${Prefix}${N}`
				| AttachmentPaths<ChildrenOf<At[N]>, `${Prefix}${N}.`>
		}[keyof At & string]
	: never

/**
 * The paths of a query Q's attachments (AttachmentPaths), read only once Q is a query (RecordsHeld): what records'
 * names are keyed by, and the members recordPaths(query) lists at run time (program/records.ts recordPathsOf).
 */
export type RecordPaths<Q> = Q extends unknown ? AttachmentPaths<AttachedOf<Q>, ""> : never

/**
 * What records(...) takes as its options' names: a relation name its author states for some of a query Q's
 * attachments, each by its path (RecordPaths); an attachment it leaves out keeps the name records derive.
 */
export type RecordNames<Q> = { readonly [P in RecordPaths<Q>]?: string }

/** The names of records that state none, records(...) called without its options: their documented default. */
export type NoRecordNames = { readonly [P in never]?: string }

/**
 * Refuses a key of Names that is no path of Q's attachments, and a stated name that is not one string literal, the key
 * a schema's types hold its relation under (RelationName).
 */
type StatedNames<Q, Names> = {
	readonly [P in keyof Names]: P extends RecordPaths<Q>
		? IsOneLiteral<Names[P] & string> extends true
			? Names[P]
			: Refusal<"a relation's name is one string literal, the key its schema's types hold it under">
		: Refusal<"records' names name only the query's attachments, each by its path">
}

/**
 * The arguments after records' owner key: none, its documented default, no name stated, or its options, `names` the
 * relation names its author states by path (RecordNames), each checked by StatedNames.
 */
export type RecordsOptions<Q, Names> =
	| readonly []
	| readonly [options: { readonly names: Names & StatedNames<Q, Names> }]

/**
 * How the relations of records of the stem Stem are named: the stem, the paths of the capitalized names an
 * attachment's relation must not repeat (RecordsPaths), and the names Names states by path.
 */
interface Naming<Stem extends string, Paths, Names> {
	readonly stem: Stem
	readonly paths: Paths
	readonly names: Names
}

/** Any naming of records' relations (Naming). */
interface AnyNaming {
	readonly stem: string
	readonly paths: unknown
	readonly names: unknown
}

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
 * The name of the relation of the attachment named N at the path Path under the relation named Parent: the name the
 * naming states for Path, or the name records derive (AttachedName).
 */
type NameAt<
	Nm extends AnyNaming,
	Path extends string,
	Parent extends string,
	N extends string
> = Path extends keyof Nm["names"]
	? Nm["names"][Path] & string
	: AttachedName<Nm["stem"], Nm["paths"], Parent, N>

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

/** A field of the parent's key as its child carries it: a place, drawn in the parent, is a natural the child states. */
type Carry<F> = F extends DrawnField<infer B> ? B : F

/**
 * The key fields a child carries its parent's key PK as, in order: each field under its parent's name, fresh beside
 * Taken and the names before it, carried (Carry).
 */
type CarriedPairs<
	PK,
	Taken,
	Out extends ReadonlyArray<AnyKeyField> = readonly []
> = PK extends readonly [KeyField<infer K, infer F>, ...infer Rest]
	? CarriedPairs<
			Rest,
			Taken | Fresh<K, Taken>,
			readonly [...Out, KeyField<Fresh<K, Taken>, Carry<F>>]
		>
	: Out

/**
 * The names a child's own records take, its columns and its attachments: a union made in a branch no alias names, one
 * union for one set of names (ArrayNames).
 */
type TakenBy<A> = [A] extends [unknown] ? keyof CarriersOf<A> | keyof ChildrenOf<A> : never

/** The names a relation's key Pairs holds, as a union. */
type NamesIn<Pairs> = Pairs extends ReadonlyArray<infer P extends AnyKeyField> ? P["name"] : never

/**
 * The key of a child, given what is read off its attachment: its carried key fields Carried, then, for an array (D),
 * its place, `at` fresh beside the names Taken its columns and attachments take and its carried names, drawn.
 */
type KeyOfChild<Carried, Taken, D> = D extends "array"
	? Carried extends ReadonlyArray<AnyKeyField>
		? readonly [...Carried, KeyField<Fresh<"at", Taken | NamesIn<Carried>>, DrawnField>]
		: never
	: Carried

/** The key of the child A under a parent of key PK, as key fields: its carried key, then, for an array, its place. */
type ChildKey<PK, A> = KeyOfChild<CarriedPairs<PK, TakenBy<A>>, TakenBy<A>, DeliveryOf<A>>

/**
 * The fields of a relation of records: its key's, its stored columns' (StoredFieldsOf over its heading of carriers Hc)
 * and its arrays' counts, under the names Ns.
 */
type FieldsOfRecords<K, Hc, Ns extends string> = Simplify<
	PairFields<K> & StoredFieldsOf<Hc> & CountsNamed<Ns>
>

/**
 * The fields of the child A under a parent of key PK (FieldsOfRecords). Each part is read off the attachment first, as
 * a key, a heading and names, so the fields are one type for one child, whichever copy of the attachment tree it was
 * read from: a type built over the attachment itself would be one type per copy, and two copies' relations, related
 * where a statement list reads them back, would be related through the queries their attachments hold.
 */
type ChildFields<PK, A> = [A] extends [unknown]
	? FieldsOfRecords<ChildKey<PK, A>, CarriersOf<A>, ArrayNames<ChildrenOf<A>>>
	: never

/**
 * The relation of the attachment A named N under the relation named PN, of key PK: its name, fields and key read first,
 * so the relation is one type for one child (ChildFields), whichever copy of the attachment tree it was read from.
 */
type ChildRelation<
	Nm extends AnyNaming,
	Prefix extends string,
	PN extends string,
	PK,
	N extends string,
	A
> = [NameAt<Nm, `${Prefix}${N}`, PN, N>, ChildFields<PK, A>] extends [
	infer Name extends string,
	infer F
]
	? PairNames<ChildKey<PK, A>> extends infer K extends ReadonlyArray<keyof F & string>
		? Relation<Name, F, K>
		: never
	: never

/**
 * The relations of the attachments At under the relation named PN, of key PK, at any depth: each attachment's own
 * (ChildRelation), and those under it, each level typed off the key of the level above alone.
 */
type AttachedRelations<Nm extends AnyNaming, Prefix extends string, PN extends string, PK, At> = {
	[N in keyof At & string]:
		| Boxed<ChildRelation<Nm, Prefix, PN, PK, N, At[N]>>
		| AttachedRelations<
				Nm,
				`${Prefix}${N}.`,
				NameAt<Nm, `${Prefix}${N}`, PN, N>,
				ChildKey<PK, At[N]>,
				ChildrenOf<At[N]>
		  >
}[keyof At & string]

/**
 * The relations of the attachments At under the relation named PN, of key PK, at any depth, that an insert states apart
 * from their parent: every child but an array's, whose members an insert nests under their owner's count
 * (types/changeset AdditionIn).
 */
type ApartRelations<Nm extends AnyNaming, Prefix extends string, PN extends string, PK, At> = {
	[N in keyof At & string]:
		| (DeliveryOf<At[N]> extends "array"
				? never
				: Boxed<ChildRelation<Nm, Prefix, PN, PK, N, At[N]>>)
		| ApartRelations<
				Nm,
				`${Prefix}${N}.`,
				NameAt<Nm, `${Prefix}${N}`, PN, N>,
				ChildKey<PK, At[N]>,
				ChildrenOf<At[N]>
		  >
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

/** The laws of the attachments At under P, of key PK, at any depth: each child's over its parent. */
type AttachedLaws<Nm extends AnyNaming, Prefix extends string, P extends RecordsParent, PK, At> = {
	[N in keyof At & string]:
		| Boxed<
				DeliveryLaw<DeliveryOf<At[N]>, P, N, ChildRelation<Nm, Prefix, P["name"], PK, N, At[N]>>
		  >
		| AttachedLaws<
				Nm,
				`${Prefix}${N}.`,
				ChildRelation<Nm, Prefix, P["name"], PK, N, At[N]>,
				ChildKey<PK, At[N]>,
				ChildrenOf<At[N]>
		  >
}[keyof At & string]
