import type { Brand } from "effect"
import type { Column } from "#compiler/core/decoder.ts"
import type { Built } from "#compiler/core/phantom.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { BaseOf } from "#compiler/types/core/phantom.ts"

/** Any descriptor: the members every runtime descriptor has, its PostgreSQL type name and its column. */
export interface FieldBase extends Built {
	readonly sql: SqlTag
	readonly column: Column<unknown>
}

/**
 * Field descriptors, nominal contracts and host value types. The descriptors are the runtime values of
 * packages/engine/src/scalar, typed here, and the host classes are the exact carriers of packages/engine/src/scalar/values.
 *
 * A descriptor's host type is the type of its column (core/decoder.ts): the conversion of a cell's text its builder
 * made, or a closed handle's roster, or a refined text's claim, so a descriptor delivers values of its host type by
 * construction. Every runtime descriptor also carries its Description and ScalarType for the compiler
 * (scalar/registry.ts), which the public types leave out, so the shapes here are exactly the public ones.
 *
 * The exact carriers: Decimal holds PostgreSQL numeric exactly and is never a JavaScript number; Money holds the
 * signed 64-bit count of minor units. Each has an `of` convenience, which throws CompileError on a malformed value.
 * The values are the public barrel's (public/fields.ts).
 *
 * A descriptor: its PostgreSQL type name, and its column, whose values are its host type.
 */
export interface Field<out Host, out Sql extends SqlTag> extends FieldBase {
	readonly sql: Sql
	readonly column: Column<Host>
}

/** Every text field carries a regex; S and F are its literal source and flags. */
export interface TextField<
	out Host extends string,
	out S extends string,
	out F extends string
> extends Field<Host, "text"> {
	readonly pattern: { readonly source: S; readonly flags: F }
}

/**
 * numeric and decimal: bare, with PostgreSQL's implementation limits, or numeric(p, s), whose precision and scale are
 * runtime values only. numeric(p) is numeric(p, 0), so a typed numeric holds both.
 */
export type NumericField = Field<Decimal, "numeric"> | NumericTypmodField

/** numeric(p, s). */
export interface NumericTypmodField extends Field<Decimal, "numeric"> {
	readonly precision: number
	readonly scale: number
}

/** float(p): real or double precision, chosen at runtime by the binary precision. */
export type FloatField = Field<number, "real"> | Field<number, "double precision">

/**
 * Lowers to GENERATED ALWAYS AS IDENTITY, with the sequence owned by the column. It is a column
 * generation declaration over an integer type, not a value domain, so it is not a span endpoint.
 */
export interface SerialField<out Host, out Sql extends SqlTag> extends Field<Host, Sql> {
	readonly generated: "always"
}

/**
 * A span's width is upper - lower, a value of the endpoint's base type: over a contract
 * endpoint such as span(Cents, 15n) it is a bare bigint, not a Cents; for every unbranded
 * endpoint that is the endpoint type itself. BaseOf is a conditional type, so the variance is measured rather than
 * annotated: a SpanField is covariant in its endpoint exactly where BaseOf is.
 */
export interface SpanField<Endpoint> extends Field<Span<Endpoint>, "range"> {
	readonly width?: BaseOf<Endpoint>
}

/** Bounded and half-open, start < end. */
export type Span<E> = { readonly start: E; readonly end: E }

/**
 * A literal operand. Over Decimal it is a Decimal, a bigint, or an exact decimal string checked at construction; a
 * JavaScript number is never a numeric literal. A literal compared with or written into a contract
 * term adopts the contract, so the literal type is the unbranded base. Without
 * BaseOf, `T extends Decimal ? Decimal | bigint | string : T` would make `r.eq(cents, 5n)` fail to typecheck.
 */
export type LiteralOf<T> =
	BaseOf<T> extends infer B ? (B extends Decimal ? Decimal | bigint | string : B) : never

export type Infer<F> = F extends Field<infer Host, SqlTag> ? Host : never
export type SqlOf<F> = F extends Field<unknown, infer Sql> ? Sql : never

/**
 * A nominal contract: base descriptor, optional total predicate, PostgreSQL domain. Its host type is
 * the base host type branded with the contract's name, so two contracts over one base are distinct types.
 * The contract is its brand's minting function: `Cents(1500n)` brands without checking, and the database validates on
 * write.
 */
export interface Contract<Name extends string, B extends FieldBase> extends Field<
	Infer<B> & Brand.Brand<Name>,
	B["sql"]
> {
	(unbranded: Brand.Brand.Unbranded<Infer<B> & Brand.Brand<Name>>): Infer<B> & Brand.Brand<Name>
	readonly name: Name
	readonly base: B
}

/**
 * Not a serial generation declaration, at any depth of contract bases. Field descriptors carry no `generated` member,
 * so an absent optional `never` admits them and refuses SerialField's `"always"`; a contract carries its base, so the
 * same test on `base` refuses a contract over a serial. The base is also a Field, which keeps the nested target from
 * being a weak type that a plain descriptor, sharing none of its optional members, would fail to match.
 */
export interface NotSerial {
	readonly generated?: never
	readonly base?: FieldBase & NotSerial
}

/**
 * A plain integer descriptor: an integer field that is not a serial generation declaration, nor a contract over one.
 */
type PlainIntegerField<Host, Sql extends SqlTag> = Field<Host, Sql> & NotSerial

/**
 * Span endpoints: pg.integer, pg.bigint and contracts over them; never a serial. A contract over
 * pg.bigint is a Field<bigint & Brand, "bigint">, and Field is covariant in its host type, so the two plain arms admit
 * every contract over an admitted base. Aliases are the same descriptors: pg.int and pg.int4 are integer, pg.int8 is
 * bigint, and pg.int2, like smallint, is not an endpoint.
 */
export type IntegerLike = PlainIntegerField<number, "integer"> | PlainIntegerField<bigint, "bigint">

/** A closed reference: the roster's handles as a PostgreSQL enum. */
export interface ClosedIdField<out C> extends Field<HandleOf<C>, "enum"> {
	readonly roster: C
}

/** The roster handles of a closed relation, read from its `handles` member. */
export type HandleOf<C> = C extends {
	readonly kind: "closed"
	readonly handles: ReadonlyArray<infer H>
}
	? H
	: never
