import type { Decoded, RowDecoder } from "#compiler/core/decoder.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Phantom } from "#compiler/core/phantom.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type {
	Carrier,
	ConstantOrigin,
	DomainOf,
	Facts,
	FactsOf,
	LanguageOf,
	Meets,
	ParamsOfEach,
	Refusal,
	Rostered,
	SqlOfCarrier,
	Source,
	Term,
	UnionToIntersection
} from "#compiler/types/core/phantom.ts"
import type {
	Bits,
	BitsField,
	ClosedIdField,
	FieldBase,
	HandleOf,
	SerialField
} from "#compiler/types/fields/field.ts"

/**
 * Whether a list of names repeats one. A widened string element proves nothing, and neither does a list whose length
 * is not known, such as the rest of a constraint TypeScript checks a failed argument against, so neither refuses.
 */
type Repeats<K> = K extends readonly [infer H, ...infer Rest]
	? string extends H
		? false
		: number extends Rest["length"]
			? false
			: H extends Rest[number]
				? true
				: Repeats<Rest>
	: false

/** A primary key lists each of its fields once (ir/desc.ts nonEmptyUniqueStrings). */
export type DistinctFields<K> =
	Repeats<K> extends true ? Refusal<"a key lists each field once"> : unknown

/**
 * The fields a primary key may list: no set, whose bit string is wider than an index entry holds (its datum is bounded
 * by a roster's most codes), and none PostgreSQL or grizzle computes from the row it would identify.
 */
export type KeyFieldOf<Fields> = {
	[K in keyof Fields]-?: Fields[K] extends
		| BitsField<unknown>
		| { readonly writing: "generated" | "accumulated" }
		? never
		: K
}[keyof Fields] &
	string

/**
 * Whether two facts of an array written out in the call share their values at the key fields K and differ elsewhere: a
 * relation's facts, a ChangeSet's and a closed relation's rows alike, are a set by identity, so a fact written twice is
 * one fact, and two facts of one key and different values break the key law, a key naming one fact. Decided where the
 * array is a tuple of at most 1,024 facts and the values are each one literal; a wider array or value, which no type
 * tells apart, and a longer literal are the run time's to judge.
 */
export type ConflictsAtKey<M, K extends ReadonlyArray<string>> = K extends readonly []
	? false
	: M extends ReadonlyArray<unknown>
		? number extends M["length"]
			? false
			: M extends readonly [...Facts1024, unknown, ...ReadonlyArray<unknown>]
				? false
				: [UnionToIntersection<FieldClaims<M, K>[number]>] extends [never]
					? true
					: false
		: false

/**
 * Each position's claims: for each field of its fact whose value is one literal, a record of the text of its key and
 * that field to the value's text, a unit type. Merged into one record, two facts of one key claim each field they share
 * at one property, which two different values meet at in never, so the merged record is never exactly where two facts
 * of one key differ at a field; an identical repeat claims the same units and merges with itself. A mapped type over
 * the positions with no recursion, so the work is a fact's claims per fact; a fact whose key no single literal types
 * claims nothing, and no claims merge to unknown.
 */
type FieldClaims<M extends ReadonlyArray<unknown>, K extends ReadonlyArray<string>> = {
	readonly [I in keyof M]: KeyText<M[I], K> extends infer Key extends string
		? FactClaims<M[I], Key, Exclude<keyof M[I] & string, K[number]>>
		: unknown
}

/**
 * One fact's claims at the fields F beside its key: each field whose value is one literal, its value's text under the
 * text of the key and the field; a field of a wider value claims nothing, so it tells no two facts apart.
 */
type FactClaims<H, Key extends string, F extends string> = {
	readonly [
		P in F as P extends keyof H
			? [ValueText<H[P]>] extends [never]
				? never
				: `${Key}\u0001${P}`
			: never
	]: P extends keyof H ? ValueText<H[P]> : never
}

/**
 * A tuple of 1,024 facts, the longest literal ConflictsAtKey judges: merging a literal's claims compares a union of a
 * claim record per fact, which TypeScript holds within its comparison limit (TS2859, "excessive complexity") at a
 * thousand facts and exceeds at three thousand; a longer literal is the run time's to judge, as a wider array is. Built
 * by doubling, so no recursion reaches the instantiation depth limit.
 */
type Facts1 = readonly [unknown]
type Facts2 = readonly [...Facts1, ...Facts1]
type Facts4 = readonly [...Facts2, ...Facts2]
type Facts8 = readonly [...Facts4, ...Facts4]
type Facts16 = readonly [...Facts8, ...Facts8]
type Facts32 = readonly [...Facts16, ...Facts16]
type Facts64 = readonly [...Facts32, ...Facts32]
type Facts128 = readonly [...Facts64, ...Facts64]
type Facts256 = readonly [...Facts128, ...Facts128]
type Facts512 = readonly [...Facts256, ...Facts256]
type Facts1024 = readonly [...Facts512, ...Facts512]

/**
 * The key law's refusal of two facts of relation Name that share the key K with different values: a key names one
 * fact. It names the relation and the key beside its sentence.
 */
export type KeyLawRefusal<Name, K> =
	Refusal<"two facts of one relation share a key with different values; a key names one fact"> & {
		readonly relation: Name
		readonly key: K
	}

/**
 * A fact's key values as one text, when each is one literal: each value tagged by its kind and the values joined by
 * NUL, which no storable text holds, so two texts are equal exactly when the key values are; never when a value is
 * wider than one literal.
 */
type KeyText<H, K extends ReadonlyArray<string>> = K extends readonly [
	infer F extends string,
	...infer Rest extends ReadonlyArray<string>
]
	? F extends keyof H
		? ValueText<H[F]> extends infer V extends string
			? [V] extends [never]
				? never
				: Rest extends readonly []
					? V
					: KeyText<H, Rest> extends infer R extends string
						? [R] extends [never]
							? never
							: `${V}\u0000${R}`
						: never
			: never
		: never
	: never

/** One key value's text, tagged by its kind: never for a value no single literal types. */
type ValueText<V> = [V] extends [never]
	? never
	: [V] extends [UnionToIntersection<V>]
		? V extends string
			? Readonly<Record<string, never>> extends Record<V, true>
				? never
				: `s${V}`
			: V extends number
				? number extends V
					? never
					: `n${V}`
				: V extends bigint
					? bigint extends V
						? never
						: `b${V}`
					: V extends boolean
						? boolean extends V
							? never
							: `t${V}`
						: never
		: never

/** A roster lists each of its handles once (ir/desc.ts nonEmptyUniqueStrings). */
export type DistinctHandles<H> =
	Repeats<H> extends true ? Refusal<"a roster lists each handle once"> : unknown

/** A set lists each of its handles once: a handle is in a set or not. */
export type DistinctMembers<H> =
	Repeats<H> extends true ? Refusal<"a set lists each of its handles once"> : unknown

/** A side lists each of its terms once (ir/desc.ts SideDesc): a field and pred of it are two terms. */
export type DistinctTerms<T> =
	Repeats<T> extends true ? Refusal<"a side lists each term once"> : unknown

/**
 * Any ordinary relation: the members every one has. A relation's fields record is its own type, so the base reads it
 * as unknown; Fact and RelationFieldsOf read a relation's precise fields.
 */
export interface AnyRelation {
	readonly kind: "relation"
	readonly name: string
	readonly fields: unknown
	readonly primaryKey: ReadonlyArray<string>
	readonly fact: RowDecoder<unknown>
}

/**
 * Ordinary relations, rosters and closed relations, facts and headings. The builders relation, relation.generated,
 * closed and closed.relation are the typed schema facade's (schema/api.ts), written under these types over the
 * admission cores of packages/engine/src/schema. test/unit/schema pins the runtime behavior and test/types/schema the
 * signatures.
 *
 * A relation carries `fact`, the decoder of its facts, which its builder makes once from its fields (schema/record.ts
 * record): a fact is that decoder's output, Decoded<[Fields]> (core/decoder.ts), each field's value of its column's
 * host type, a generated field's included. A roster's fact is its handle under `id`, a closed relation's its row. Each
 * carries its heading too, the record of carriers v mints its variables over: a relation's and a closed relation's
 * fields, a roster's id carrier.
 */
export interface Relation<
	Name extends string,
	Fields,
	PrimaryKey extends ReadonlyArray<keyof Fields & string>
> extends AnyRelation {
	readonly kind: "relation"
	readonly name: Name
	readonly fields: Fields
	readonly primaryKey: PrimaryKey
	readonly fact: RowDecoder<FactOfFields<Fields>>
	readonly heading: Fields
}

/**
 * A roster: the handles it introduces, a non-empty tuple in declared order, which is their codes' order and comparison
 * order, and the order the schema expands an alternatives law's arms in. Its facts are its handles under `id`.
 * Any roster: the members every one has.
 */
export interface AnyRoster {
	readonly kind: "closed"
	readonly name: string
	readonly handles: NonEmptyReadonlyArray<string>
	readonly fact: RowDecoder<unknown>
}

export interface Roster<
	Name extends string,
	Handles extends NonEmptyReadonlyArray<string>
> extends AnyRoster {
	readonly kind: "closed"
	readonly name: Name
	readonly handles: Handles
	readonly fact: RowDecoder<RosterFactOf<Handles[number]>>
	readonly heading: ClosedId<Handles[number], Name>
	/**
	 * A member of the roster as a typed constant: a term of the roster's closed id, whose one value, which its column
	 * delivers, is the member, and whose language is every handle, which a JavaScript value opposite it may be. It
	 * stands wherever a term of the roster's closed id stands. A method, so no member's name meets a property's.
	 */
	readonly handle: <const M extends Handles[number]>(
		member: M
	) => Term<
		Handles[number] & Rostered<Name>,
		unknown,
		ConstantOrigin,
		"code",
		M,
		Facts,
		Handles[number]
	>
}

/**
 * The id part of a roster's facts and heading: its handle column under `id`, a closed id of the roster Name's
 * identity. A record type, so it is a part of a record (core/decoder.ts Part).
 */
export type ClosedId<Handle, Name extends string> = {
	readonly id: Carrier<Handle, "code", Handle & Rostered<Name>>
}

/** What a roster's fact decoder delivers: its handle under `id`. */
type RosterFactOf<Handle> = Decoded<[{ readonly id: Carrier<Handle, "code"> }]>

/**
 * A closed relation: rows over closed ids and open-typed values, fixed when the schema compiles. Its key is required
 * and is closed ids, whose codes index its constant; a set lists every field. Any closed relation: the members every
 * one has.
 */
export interface AnyClosedRelation {
	readonly kind: "closedRelation"
	readonly name: string
	readonly fields: unknown
	readonly key: NonEmptyReadonlyArray<string>
	readonly fact: RowDecoder<unknown>
}

/** The fields of a record of descriptors that are closed ids, the fields a closed relation's key may list. */
export type ClosedIdFieldOf<Fields> = {
	[K in keyof Fields]-?: Fields[K] extends ClosedIdField<AnyRoster> ? K : never
}[keyof Fields] &
	string

/** A closed relation's fields beside its key: the payload, the fields C.at reads. */
export type PayloadFieldOf<Fields, Key extends ReadonlyArray<string>> = Exclude<
	keyof Fields & string,
	Key[number]
>

/**
 * What a key position of C.at and C.row takes: a term that meets the key field's closed id, or one of its roster's
 * handles as a JavaScript value.
 */
export type KeyArgOf<F> = Meets<DomainOf<F>, SqlOfCarrier<F>> | LanguageOf<F>

/** C.at's key: one argument per key field, in key order. */
export type KeyTerms<Fields, Key extends ReadonlyArray<string>> = {
	readonly [I in keyof Key]: Key[I] extends keyof Fields ? KeyArgOf<Fields[Key[I]]> : never
}

/** C.row's prefix: one argument per key field but the last, in key order, leaving the last field open. */
export type KeyPrefixTerms<Fields, Key extends ReadonlyArray<string>> = Key extends readonly [
	...infer Prefix extends ReadonlyArray<string>,
	string
]
	? KeyTerms<Fields, Prefix>
	: never

/** The roster of a closed relation's last key field, the one C.row leaves open. */
export type LastKeyRoster<Fields, Key extends ReadonlyArray<string>> = Key extends readonly [
	...ReadonlyArray<string>,
	infer Last extends keyof Fields
]
	? Fields[Last] extends ClosedIdField<infer C>
		? C
		: never
	: never

/**
 * A closed read's arguments read no parameter: a closed read stands in a schema's predicates and in generation
 * expressions, which have none.
 */
export type ParameterlessKey<A extends ReadonlyArray<unknown>> = [keyof ParamsOfEach<A>] extends [
	never
]
	? unknown
	: Refusal<"a schema predicate reads no parameter">

/**
 * A closed read's result, of domain D and SQL type Sql, with the facts F and language L of the field it reads. It
 * delivers no value a decoder reads and is no variable a key reads: a closed read stands in predicates and generation
 * expressions, never in a head, so neither its values nor its origin are stated.
 */
type ClosedRead<D, Sql extends SqlTag, F extends Facts, L> = Term<
	D,
	unknown,
	unknown,
	Sql,
	unknown,
	F,
	L
>

/**
 * How closed.relation's migration states its constants: `pack: "rows"`, the default, lists its rows, a line each with
 * the handles it holds, for a person to review; `pack: "hex"` states each constant as one bit-string literal, for rows
 * a machine builds and no person reviews. A pack whose rows do not fit one statement is hex whatever is declared, and a
 * change of form installs nothing: either form installs the same constant.
 */
export interface ClosedRelationOptionRecord {
	readonly pack?: "rows" | "hex"
}

/** closed.relation's trailing argument: none, its rows listed, or its options (ClosedRelationOptionRecord). */
export type ClosedRelationOptions = readonly [] | readonly [options: ClosedRelationOptionRecord]

export interface ClosedRelation<
	Name extends string,
	Fields extends Readonly<Record<string, FieldBase>>,
	Key extends NonEmptyReadonlyArray<keyof Fields & string>
> extends AnyClosedRelation {
	readonly kind: "closedRelation"
	readonly name: Name
	readonly fields: Fields
	readonly key: Key
	readonly rows: ReadonlyArray<FactOfFields<Fields>>
	/** How its migration states its constants, as declared (ClosedRelationOptions), its rows by default. */
	readonly pack: "rows" | "hex"
	readonly fact: RowDecoder<FactOfFields<Fields>>
	readonly heading: Fields
	/**
	 * C.at(field, k…): the relation applied as a function, payload field `field` of the row whose key is k…, of that
	 * field's type. A key no row holds reads NULL, which a predicate's IS TRUE refuses and a generated column's NOT NULL
	 * refuses: absence is never a value.
	 */
	readonly at: <const P extends PayloadFieldOf<Fields, Key>, const A extends KeyTerms<Fields, Key>>(
		field: P,
		...key: A & ParameterlessKey<A>
	) => ClosedRead<
		DomainOf<Fields[P]>,
		SqlOfCarrier<Fields[P]>,
		FactsOf<Fields[P]>,
		LanguageOf<Fields[P]>
	>
	/**
	 * C.row(k…): the last key field's values that complete the key prefix k…, as a set over that field's roster
	 * (currying). The prefix is every key field but the last: a prefix that left two open would be no set over one
	 * roster.
	 */
	readonly row: <const A extends KeyPrefixTerms<Fields, Key>>(
		...prefix: A & ParameterlessKey<A>
	) => ClosedRead<Bits<LastKeyRoster<Fields, Key>>, "bits", Facts, Bits<LastKeyRoster<Fields, Key>>>
}

/** Any closed relation of either form: a roster, which introduces handles, or a closed relation, which relates them. */
export type AnyClosed = AnyRoster | AnyClosedRelation

/** The host fact of a record of descriptors: the output of its fact decoder, each field's column's host value. */
export type FactOfFields<Fields> = Decoded<[Fields]>

/**
 * The host fact of a relation, roster, closed relation, derived relation, or record of descriptors. A roster is matched
 * at its own name: its handle's domain is its roster's (Rostered<Name>), invariantly, so no other name meets it.
 */
export type Fact<R> =
	R extends Roster<infer _Name, infer Handles>
		? { readonly id: Handles[number] }
		: R extends { readonly fields: infer Fields }
			? FactOfFields<Fields>
			: R extends Phantom<{ readonly fields: infer Fields }>
				? FactOfFields<Fields>
				: R extends Record<string, FieldBase>
					? FactOfFields<R>
					: never

/**
 * The field descriptors of a relation: an ordinary relation's own, or those a derived relation's definition gives it,
 * which no runtime value holds before compilation.
 */
export type RelationFieldsOf<R> = R extends { readonly fields: infer Fields }
	? Fields
	: R extends Phantom<{ readonly fields: infer Fields }>
		? Fields
		: never

/** The heading of anything `match` consumes: a source's own heading, or the fact type of a relation. */
export type HeadingOf<R> = R extends Source<infer H> ? H : Fact<R>

/**
 * The fields of R that are serial generation declarations, read from the declared fields.
 */
export type SerialFieldsOf<R> = R extends { readonly fields: infer Fields }
	? {
			[K in keyof Fields]-?: Fields[K] extends SerialField<unknown, SqlTag> ? K : never
		}[keyof Fields]
	: never

export type { HandleOf }

export type NameOf<X> = X extends { readonly name: infer N extends string } ? N : never
