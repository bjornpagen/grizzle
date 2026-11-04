import type { Brand } from "effect"
import type { Columned } from "#compiler/core/decoder.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	BaseOf,
	DomainOf,
	Facts,
	IsOneLiteral,
	Parameterless,
	Predicate,
	Refusal
} from "#compiler/types/core/phantom.ts"

import type {
	ClosedIdField,
	Contract,
	DeclaredFacts,
	Field,
	FieldBase,
	FloatField,
	Infer,
	IntegerLike,
	NumericTypmodField,
	SerialField,
	SpanField
} from "#compiler/types/fields/field.ts"
import type { AnyClosed, HandleOf } from "#compiler/types/schema/relation.ts"
import type { VectorField } from "#compiler/types/vector/vector.ts"

/**
 * numeric(p) and numeric(p, s), and their decimal spelling. An omitted scale is 0; precision 1-1000 and
 * scale -1000-1000 are checked at runtime.
 */
type NumericConstructor = (precision: number, scale?: number) => NumericTypmodField

/** float(p): real for binary precision 1-24, double precision for 25-53, chosen at runtime. */
type FloatConstructor = (precision: number) => FloatField

/**
 * The signatures of the field descriptor constructors: uuid, pg, contract, span and closedId, the runtime values of
 * packages/engine/src/scalar, which the public barrel public/fields.ts binds to them. str.regex is packages/engine/src/text's, with
 * its own signature (text/field.ts Str).
 *
 * A descriptor's host type is the type of its column, the conversion its builder made, and the runtime descriptors
 * carry their literal SQL names and members (scalar/registry.ts defineField), so every binding has its public type by
 * construction. Typmod arguments are runtime values: numeric precision and scale, float's binary precision, vector
 * dimensions and span widths are checked by the runtime builders, which throw CompileError MalformedDescription on a
 * malformed one. A vector's dimension count is the one literal the type keeps, an equality-only tag.
 * A contract is its brand's minting function, the call of Effect's brand constructor: it brands without checking, and
 * the database validates on write. test/unit/scalar pins the runtime behavior, and test/types/fields the signatures.
 *
 * The pg namespace, every PostgreSQL spelling included. An alias is the same descriptor
 * as the name it spells, so it has the same type.
 */
export interface Pg {
	readonly smallint: Field<number, "smallint">
	readonly int2: Field<number, "smallint">
	readonly integer: Field<number, "integer">
	readonly int: Field<number, "integer">
	readonly int4: Field<number, "integer">
	readonly bigint: Field<bigint, "bigint">
	readonly int8: Field<bigint, "bigint">
	readonly numeric: Field<Decimal, "numeric"> & NumericConstructor
	readonly decimal: Field<Decimal, "numeric"> & NumericConstructor
	readonly real: Field<number, "real">
	readonly float4: Field<number, "real">
	readonly "double precision": Field<number, "double precision">
	readonly float8: Field<number, "double precision">
	readonly float: Field<number, "double precision"> & FloatConstructor
	readonly money: Field<Money, "money">
	readonly boolean: Field<boolean, "boolean">
	readonly bool: Field<boolean, "boolean">
	readonly smallserial: SerialField<number, "smallint">
	readonly serial2: SerialField<number, "smallint">
	readonly serial: SerialField<number, "integer">
	readonly serial4: SerialField<number, "integer">
	readonly bigserial: SerialField<bigint, "bigint">
	readonly serial8: SerialField<bigint, "bigint">
	/** pg.vector(1536): a model-agnostic vector field; the dimension count is an equality-only tag. */
	readonly vector: <const N extends number>(dimensions: N) => VectorField<N>
}

/**
 * A nominal contract over a base descriptor, with an optional total predicate over one value. The predicate receives
 * the base's scalar, of the base's domain and SQL type, whose language is the base's host type, so
 * `contract("Cents", pg.bigint, (v) => v.ge(0n))` reads naturally.
 * A contract is a value domain and lowers to a PostgreSQL domain; a serial is a column generation declaration, not a
 * value domain, and PostgreSQL admits an identity column only over smallint, integer or bigint, never
 * over a domain. So the base is never a serial; a contract over the underlying integer type is the value domain.
 * The contract's column is the base's, branded by the contract's own constructor, which takes the unbranded host value:
 * the base's column delivers it (ContractBase). The name is one literal, the one brand its values carry.
 *
 * After the predicate, `{ proves: ["nonzero"] }` declares the facts it proves, which the contract's type then states
 * of its values, so a divisor of the contract needs no guard; compilation proves each from the predicate, else refuses
 * the declaration: `contract("Divisor", pg.bigint, (v) => v.ne(0n), { proves: ["nonzero"] })`.
 */
export type ContractConstructor = <
	const Name extends string,
	B extends FieldBase,
	Pr extends Predicate = Predicate,
	const Proved extends ReadonlyArray<keyof Facts> = readonly []
>(
	name: Name,
	base: B & NotSerialBase<B> & ContractBase<NoInfer<Name>, B> & OneContractName<NoInfer<Name>>,
	predicate?: (
		v: Scalar<DomainOf<B>, unknown, unknown, B["sql"], Infer<B>>
	) => Pr & Parameterless<Pr>,
	declared?: { readonly proves: Proved }
) => Contract<Name, B, DeclaredFacts<Proved>>

/**
 * A contract's name is one literal: a union of names would brand its values with every one of them, and a wider string
 * would make every contract over a base with such a name one type.
 */
export type OneContractName<Name extends string> =
	IsOneLiteral<Name> extends true
		? unknown
		: Refusal<"a contract's name is one literal, the brand of its values">

/** A base whose column delivers what the contract's brand constructor takes: its host value, every brand stripped. */
export type ContractBase<Name extends string, B> = Columned<
	Brand.Brand.Unbranded<Infer<B> & Brand.Brand<Name>>
>

export type NotSerialBase<B> =
	B extends SerialField<unknown, SqlTag>
		? Refusal<"a contract is a value domain; a serial is a generation declaration, so use its integer type">
		: unknown

/**
 * A bounded half-open span over an integer endpoint; never over a serial. The width is upper - lower,
 * a positive value of the endpoint's base type, checked at runtime. The span's column converts each endpoint with the
 * endpoint's own column, so span(Cents) delivers Span<Cents>.
 */
export type SpanConstructor = <E extends IntegerLike>(
	endpoint: E & Columned<Infer<E>>,
	width?: BaseOf<Infer<E>>
) => SpanField<Infer<E>>

/** A closed reference: its column is the roster's handles, the closed relation's non-empty tuple of literals. */
export type ClosedIdConstructor = <C extends AnyClosed>(
	closed: C & { readonly handles: NonEmptyReadonlyArray<HandleOf<C>> }
) => ClosedIdField<C>
