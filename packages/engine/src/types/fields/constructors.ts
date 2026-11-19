import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Brand } from "effect"
import type { Columned } from "#compiler/core/decoder.ts"
import type { mintedRefusal } from "#compiler/scalar/minted.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	DomainOf,
	Facts,
	InputTerm,
	IsOneLiteral,
	ContractValueOrigin,
	Hosted,
	Parameterless,
	Predicate,
	Refusal
} from "#compiler/types/core/phantom.ts"

import type {
	AccumulatedField,
	BitsField,
	ClosedIdField,
	Contract,
	DrawnField,
	Field,
	FieldBase,
	GeneratedField,
	Infer,
	NaturalField,
	NamedId,
	NoWriting,
	NotInstant,
	NotStoredOnly,
	NumericTypmodField,
	SpanEndpointLike,
	SpanField,
	SpanWidthOf,
	StoredOnlySql,
	WritingTag
} from "#compiler/types/fields/field.ts"
import type { AnyRoster, HandleOf } from "#compiler/types/schema/relation.ts"
import type { VectorField } from "#compiler/types/vector/vector.ts"

/**
 * numeric(p, s), precision and scale both declared: no numeric field is without them.
 * PostgreSQL's numerictypmodin rule is checked at runtime (ir/carriers.ts numericMaxPrecision, numericMinScale and
 * numericMaxScale).
 */
type NumericConstructor = (precision: number, scale: number) => NumericTypmodField

/**
 * The signatures of the field descriptor constructors: uuid, pg, contract, span and closedId, the runtime values of
 * packages/engine/src/scalar, which the public barrel public/fields.ts binds to them. str.regex is packages/engine/src/text's, with
 * its own signature (text/field.ts Str).
 *
 * A descriptor's host type is the type of its column, the conversion its builder made, and the runtime descriptors
 * carry their literal SQL names and members (scalar/registry.ts defineField), so every binding has its public type by
 * construction. Typmod arguments are runtime values: numeric precision and scale, vector dimensions and span widths
 * are checked by the runtime builders, which throw CompileError MalformedDescription on a malformed one. A vector's
 * dimension count is the one literal the type keeps, an equality-only tag.
 * A contract is its brand's minting function, the call of Effect's brand constructor: it brands without checking, and
 * the database validates on write. test/unit/scalar pins the runtime behavior, and test/types/fields the signatures.
 *
 * The pg namespace: each type under the one name PostgreSQL's format_type prints for it, its SQL tag.
 */
export interface Pg {
	readonly smallint: Field<number, "smallint">
	readonly integer: Field<number, "integer">
	readonly bigint: Field<bigint, "bigint">
	readonly numeric: NumericConstructor
	readonly real: Field<number, "real">
	readonly "double precision": Field<number, "double precision">
	readonly money: Field<Money, "money">
	readonly boolean: Field<boolean, "boolean">
	/** pg.smallserial, pg.serial, pg.bigserial and pg.uuidv7 are refusals, no field (scalar/minted.ts). */
	readonly smallserial: Refusal<typeof mintedRefusal>
	readonly serial: Refusal<typeof mintedRefusal>
	readonly bigserial: Refusal<typeof mintedRefusal>
	readonly uuidv7: Refusal<typeof mintedRefusal>
	/** pg.vector(1536): a model-agnostic vector field; the dimension count is an equality-only tag. */
	readonly vector: <const N extends number>(dimensions: N) => VectorField<N>
}

/**
 * A nominal contract over a base descriptor, with an optional total predicate over one value. The predicate receives
 * the base's scalar, of the base's domain and SQL type, whose language is the base's host type, which Compute's
 * comparisons read: `contract("Cents", pg.bigint, (v) => Compute.ge(v, 0n))`.
 * A contract is a value domain and lowers to a PostgreSQL domain, so its base is a value type: never a field of a
 * writing of its own (NoWriting), which grizzle or PostgreSQL writes.
 * The contract's column is the base's, branded by the contract's own constructor, which takes the unbranded host value:
 * the base's column delivers it (ContractBase). The name is one literal, the one brand its values carry.
 *
 * After the predicate, `{ proves: ["nonzero"] }` declares the facts it proves, which the contract's type then states
 * of its values, so a divisor of the contract needs no guard; compilation proves each from the predicate, else refuses
 * the declaration: `contract("Divisor", pg.bigint, (v) => Compute.ne(v, 0n), { proves: ["nonzero"] })`.
 */
export type ContractConstructor = <
	const Name extends string,
	B extends FieldBase,
	Pr extends Predicate<never> = Predicate,
	const Proved extends ReadonlyArray<keyof Facts> = readonly []
>(
	name: Name,
	base: B &
		NoWriting &
		NotStoredOnly<B["sql"]> &
		NotInstantBase<B> &
		ContractBase<NoInfer<Name>, B> &
		OneContractName<NoInfer<Name>>,
	predicate?: (
		v: Scalar<DomainOf<B>, unknown, ContractValueOrigin, B["sql"], Infer<B>>
	) => Pr & Parameterless<Pr> & Hosted<Pr>,
	declared?: { readonly proves: Proved }
) => Contract<Name, B, Proved>

/**
 * A contract's name is one literal: a union of names would brand its values with every one of them, and a wider string
 * would make every contract over a base with such a name one type.
 */
export type OneContractName<Name extends string> =
	IsOneLiteral<Name> extends true
		? [Name] extends ["instant"]
			? Refusal<"a contract's name is apart from instant, the database's clock's own type">
			: unknown
		: Refusal<"a contract's name is one literal, the brand of its values">

/** A base whose column delivers what the contract's brand constructor takes: its host value, every brand stripped. */
export type ContractBase<Name extends string, B> = Columned<
	Brand.Brand.Unbranded<Infer<B> & Brand.Brand<Name>>
>

/** A contract's base or a span's endpoint that is no instant, which no caller brands (NotInstant). */
export type NotInstantBase<B> = NotInstant<DomainOf<B>>

/**
 * A bounded half-open span over an integer or a date endpoint. The width is upper - lower, a
 * positive value of the endpoint's base type, or a count of days over a date, checked at runtime. The span's column
 * converts each endpoint with the endpoint's own column, so span(Cents) delivers Span<Cents> and span(date)
 * Span<CalendarDate>.
 */
export type SpanConstructor = <E extends SpanEndpointLike>(
	endpoint: E & Columned<Infer<E>> & NoWriting & NotInstantBase<E>,
	width?: SpanWidthOf<Infer<E>>
) => SpanField<Infer<E>, DomainOf<E>>

/** A closed reference: its column is the roster's handles, the roster's non-empty tuple of literals. */
export type ClosedIdConstructor = <C extends AnyRoster>(
	roster: C & { readonly handles: NonEmptyReadonlyArray<HandleOf<C>> }
) => ClosedIdField<C>

/** A set over a roster: its column reads a bit string into the set of handles its 1 bits' codes name. */
export type BitsConstructor = <C extends AnyRoster>(
	roster: C & { readonly handles: NonEmptyReadonlyArray<HandleOf<C>> }
) => BitsField<C>

/** drawn(natural): a natural grizzle draws, a family's index or count or a tree's start or end. */
export type DrawnConstructor = (type: NaturalField) => DrawnField

/**
 * An accumulated field is of a value type: no span, no vector, and no field of a writing of its own; and no bytes, which
 * grizzle never fills (NotStoredOnly).
 */
export type Accumulable<F> = F extends
	| SpanField<unknown, unknown>
	| VectorField<number>
	| { readonly writing: WritingTag }
	? Refusal<"an accumulated field is of a value type: no span, vector or field of a writing of its own">
	: F extends { readonly sql: StoredOnlySql }
		? NotStoredOnly<StoredOnlySql>
		: unknown

/**
 * accumulated(type, start): a field of `type` grizzle fills on the host and PostgreSQL proves, a fold's accumulator or
 * a copy along a family axis, holding `start`, a value of `type`, at its axis's base.
 */
export type AccumulatedConstructor = <const F extends FieldBase>(
	type: F & Accumulable<F>,
	start: Infer<F>
) => AccumulatedField<F>

/**
 * A term of the declared type F exactly: its identity and SQL type are F's, as PostgreSQL types a generation expression
 * by its column's type, with no implicit cast.
 */
export type GeneratedTermOf<F extends FieldBase> = InputTerm<DomainOf<F>, never, unknown, F["sql"]>

/**
 * generated(type, term): a field PostgreSQL writes, a STORED generated column of `type` whose value is `term`, read off
 * the row relation.generated hands its callback. The term is of `type` exactly and reads no parameter: its row's
 * written fields and closed reads are all a generation expression may read.
 */
export type GeneratedConstructor = <F extends FieldBase, T extends GeneratedTermOf<F>>(
	type: F & NoWriting & NotStoredOnly<F["sql"]> & NamedId<F>,
	term: T & Parameterless<T> & Hosted<T>
) => GeneratedField<F>
