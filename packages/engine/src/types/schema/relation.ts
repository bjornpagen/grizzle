import type { Decoded, RowDecoder } from "#compiler/core/decoder.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Phantom } from "#compiler/core/phantom.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type {
	Carrier,
	ConstantOrigin,
	Facts,
	Refusal,
	Rostered,
	Simplify,
	Source,
	Term
} from "#compiler/types/core/phantom.ts"
import type { FieldBase, HandleOf, SerialField } from "#compiler/types/fields/field.ts"

/** Whether a list of field names repeats one. A widened string element proves nothing, so it never refuses. */
type Repeats<K> = K extends readonly [infer H, ...infer Rest]
	? string extends H
		? false
		: H extends Rest[number]
			? true
			: Repeats<Rest>
	: false

/** A key lists each of its fields once (ir/desc.ts nonEmptyUniqueStrings). */
export type DistinctFields<K> =
	Repeats<K> extends true ? Refusal<"a key lists each field once"> : unknown

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
 * Ordinary and closed relations, facts and headings; closed relations are first-class facts. The builders relation and
 * closed are the typed schema facade's (schema/api.ts), written under these types over the admission cores of
 * packages/engine/src/schema. test/unit/schema pins the runtime behavior and test/types/schema the signatures.
 *
 * A relation carries `fact`, the decoder of its facts, which its builder makes once from its fields (schema/record.ts
 * record): a fact is that decoder's output, Decoded<[Fields]> (core/decoder.ts), each field's value of its column's
 * host type. A closed relation's fact is its handle under `id`, from its roster's handle column, beside its payload.
 * Each carries its heading too, the record of carriers v mints its variables over: a relation's fields, and a closed
 * relation's id carrier beside its payload.
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

/** The payload facts of a closed relation: one for every handle of its roster. */
export type FactsOf<Handle extends string, Payload> = {
	readonly [H in Handle]: FactOfFields<Payload>
}

/**
 * A closed relation is also a relation with heading { id: Handle } & Payload and primary key ["id"].
 * Handles keeps the roster as written, a non-empty tuple in declared order, which is comparison order and the order
 * the schema expands an alternatives law's arms in.
 * Any closed relation: the members every one has.
 */
export interface AnyClosed {
	readonly kind: "closed"
	readonly name: string
	readonly handles: NonEmptyReadonlyArray<string>
	readonly payload: unknown
	readonly facts: unknown
	readonly fact: RowDecoder<unknown>
}

export interface Closed<
	Name extends string,
	Handle extends string,
	Payload,
	Handles extends NonEmptyReadonlyArray<Handle> = NonEmptyReadonlyArray<Handle>
> extends AnyClosed {
	readonly kind: "closed"
	readonly name: Name
	readonly handles: Handles
	readonly payload: Payload
	readonly facts: FactsOf<Handle, Payload>
	readonly fact: RowDecoder<ClosedFactOf<Handle, Payload>>
	readonly heading: ClosedId<Handle, Name> & Payload
	/**
	 * A member of the roster as a typed constant: a term of the roster's enum, whose one value, which its column
	 * delivers, is the member, and whose language is every handle, which a JavaScript value opposite it may be. It
	 * stands wherever a term of the roster's enum stands. A method, so no member's name meets a property's.
	 */
	readonly handle: <const M extends Handle>(
		member: M
	) => Term<Handle & Rostered<Name>, unknown, ConstantOrigin, "enum", M, Facts, Handle>
}

/**
 * The id part of a closed relation's facts and heading: its roster's handle column under `id`, an enum, of the roster
 * Name's identity. A record type, so it is a part of a record (core/decoder.ts Part).
 */
export type ClosedId<Handle, Name extends string> = {
	readonly id: Carrier<Handle, "enum", Handle & Rostered<Name>>
}

/**
 * What a closed relation's fact decoder delivers: its handle under `id` beside its payload's fields. Fact reads it
 * flattened, which is mutually assignable with it.
 */
type ClosedFactOf<Handle, Payload> = Decoded<[{ readonly id: Carrier<Handle, "enum"> }, Payload]>

/**
 * The enum-only form closed(name, handles) returns: a closed relation with the empty payload, whose `with` adds one.
 */
export interface EnumClosed<
	Name extends string,
	Handles extends NonEmptyReadonlyArray<string>
> extends Closed<Name, Handles[number], unknown, Handles> {
	readonly with: <const Payload extends Record<string, FieldBase>>(
		payload: Payload,
		facts: FactsOf<Handles[number], Payload>
	) => Closed<Name, Handles[number], Payload, Handles>
}

/** The host fact of a record of descriptors: the output of its fact decoder, each field's column's host value. */
export type FactOfFields<Fields> = Decoded<[Fields]>

/**
 * The host fact of a relation, closed relation, derived relation, or record of descriptors. A closed relation is
 * matched at its own name: its handle's domain is its roster's (Rostered<Name>), invariantly, so no other name meets it.
 */
export type Fact<R> =
	R extends Closed<infer _Name, infer H, infer Payload>
		? Simplify<{ readonly id: H } & FactOfFields<Payload>>
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
