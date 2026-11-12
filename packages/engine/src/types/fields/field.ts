import type { Brand } from "effect"
import type { Column, FieldHost } from "#compiler/core/decoder.ts"
import type {
	Built,
	Domained,
	domain,
	Languaged,
	language,
	Proving
} from "#compiler/core/phantom.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import type { Patterns } from "#compiler/ir/scalar.ts"
import type { FloatPrecision, FloatSql } from "#compiler/scalar/pg.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type {
	BaseOf,
	DeclaresAll,
	DomainOf,
	Facts,
	FactsOf,
	LanguageOf,
	Refusal,
	Rostered
} from "#compiler/types/core/phantom.ts"

/**
 * Any descriptor: the members every runtime descriptor has, its PostgreSQL type name and its column, and the domain
 * and language it states, which are any for a descriptor of unknown type: a variable minted over one is of unknown
 * type, never of none.
 */
export interface FieldBase extends Built, Domained<unknown>, Languaged<unknown> {
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
 * A descriptor: its PostgreSQL type name Sql, its column, whose values are its host type, and the descriptor of its
 * type it states (types/core/phantom.ts Term): its domain D, the host type with every identity the checker reads (a
 * closed reference's roster brand), the facts F its values are proved to have, and its language, every value of its
 * type, which is its host type: a descriptor's column delivers all of them.
 */
/** A calendar date host value, the date field's: its ISO 8601 text (ir/date.ts). */
export type { CalendarDate } from "#compiler/ir/date.ts"

/** date: a calendar day, its host value and language its ISO 8601 text (scalar/date.ts). */
export type DateField = Field<CalendarDate, "date">

/**
 * bytes: PostgreSQL's bytea, its host value a Uint8Array over its own ArrayBuffer, written and read back whole: its SQL
 * type is stored only (StoredOnlySql) (scalar/bytes.ts).
 */
export type BytesField = Field<Uint8Array<ArrayBuffer>, "bytea">

/**
 * The SQL types of storage alone, the type level's reading of a capability set of storage only (scalar/registry.ts
 * storedOnly): the SQL types of the stored-only fields, bytes the one such field. A value of one is written and read back
 * whole, so no key, side, computation, parameter, filter, contract or written-by-PostgreSQL field takes one.
 */
export type StoredOnlySql = BytesField["sql"]

/**
 * The refusal of a descriptor or term of SQL type Sql where it is stored only (StoredOnlySql), which no key, rule,
 * computation, parameter, filter, contract or written-by-PostgreSQL field takes; nothing for any other.
 */
export type NotStoredOnly<Sql> = [Sql] extends [StoredOnlySql]
	? Refusal<"bytes are stored only, written and read back whole: no key, rule, computation, parameter or filter reads them">
	: unknown

export interface Field<out Host, out Sql extends SqlTag, out D = Host, out F extends Facts = Facts>
	extends FieldBase, Proving<F> {
	readonly [domain]?: D | undefined
	readonly [language]?: Host | undefined
	readonly sql: Sql
	readonly column: Column<Host>
}

/**
 * Every text field carries patterns, a non-empty conjunction: str.regex's one, or each joined text's for str.and. Its
 * host type and language are its patterns' (RegexInfer), intersected, and its domain is text: the checker meets text
 * with text whatever their patterns, as PostgreSQL compares them, and checks a JavaScript value against the patterns
 * (ContractLiteral), as the language does.
 */
export interface TextField<out Host extends string> extends Field<Host, "text", string> {
	readonly patterns: Patterns
}

/**
 * numeric(p, s), its precision and scale both declared, as every numeric field is: runtime values only, so the type is
 * one for every typmod.
 */
export interface NumericTypmodField extends Field<Decimal, "numeric"> {
	readonly precision: number
	readonly scale: number
}

/** float(p): the real or double precision field its binary precision P resolves to. */
export type FloatField<P extends FloatPrecision> = Field<number, FloatSql<P>>

/**
 * natural: a bigint never below zero, which its values are proved to be, and the one field type a law side may read
 * pred of. Its host type is bigint, unbranded; `natural` is the member that tells it from every other bigint field.
 */
export interface NaturalField extends Field<
	bigint,
	"bigint",
	bigint,
	{ readonly nonnegative: true }
> {
	readonly natural: true
}
/**
 * How a field is written, as its descriptor's type states it under `writing`; a caller's field carries none.
 * generated: by PostgreSQL from its row; drawn: by grizzle from the nested arrays its caller writes; accumulated: by
 * grizzle on the host, proved by PostgreSQL; serial: by its sequence; retirement: by its group's retirement.
 */
export type WritingTag = "generated" | "drawn" | "accumulated" | "serial" | "retirement"

/**
 * Lowers to GENERATED ALWAYS AS IDENTITY, with the sequence owned by the column. It is a column
 * generation declaration over an integer type, not a value domain, so it is not a span endpoint.
 */
export interface SerialField<out Host, out Sql extends SqlTag> extends Field<Host, Sql> {
	readonly writing: "serial"
}

/**
 * A span's width is upper - lower, a value of the endpoint's base type: over a contract
 * endpoint such as span(Cents, 15n) it is a bare bigint, not a Cents; for every unbranded
 * endpoint that is the endpoint type itself. BaseOf is a conditional type, so the variance is measured rather than
 * annotated: a SpanField is covariant in its endpoint exactly where BaseOf is. Its host is the span of its endpoint's
 * host, Endpoint, and its domain the span of its endpoint's domain, EndpointDomain: over a contract, the contract's
 * domain with the facts it declares, so a span over Cents meets a point of Cents (r.pointIn) as the engine does.
 */
export interface SpanField<Endpoint, EndpointDomain> extends Field<
	Span<Endpoint>,
	"range",
	Span<EndpointDomain>
> {
	readonly width?: SpanWidthOf<Endpoint>
}

/**
 * A literal operand. Over Decimal it is a Decimal, a bigint, or an exact decimal string checked at construction; a
 * JavaScript number is never a numeric literal. A literal compared with or written into a contract
 * term adopts the contract, so the literal type is the unbranded base. Without
 * BaseOf, `T extends Decimal ? Decimal | bigint | string : T` would make `r.eq(cents, 5n)` fail to typecheck.
 */
export type LiteralOf<T> =
	BaseOf<T> extends infer B ? (B extends Decimal ? Decimal | bigint | string : B) : never

export type Infer<F> = FieldHost<F>
export type SqlOf<F> = F extends Field<unknown, infer Sql> ? Sql : never

/** The facts a contract declares: each named fact proved; none declared is the empty declaration. */
export type DeclaredFacts<Proved extends ReadonlyArray<keyof Facts>> = {
	readonly [K in Proved[number]]: true
}

/** What a contract's domain carries of the facts it declares: one Declares per fact, nothing where it declares none. */
type DeclaredDomain<Proved extends ReadonlyArray<keyof Facts>> = [Proved[number]] extends [never]
	? unknown
	: DeclaresAll<Proved[number]>

/**
 * A nominal contract: base descriptor, optional total predicate, PostgreSQL domain. Its host type is
 * the base host type branded with the contract's name, so two contracts over one base are distinct types.
 * The contract is its brand's minting function: `Cents(1500n)` brands without checking, and the database validates on
 * write. Its values have its base's facts and the facts it declares its predicate proves (Proved), which compilation
 * proves from the predicate; its domain, its identity, carries the declared ones (Declares), so every value of its type
 * has them, read from a query's heading too.
 */
export interface Contract<
	Name extends string,
	B extends FieldBase,
	Proved extends ReadonlyArray<keyof Facts> = readonly []
> extends Field<
	Infer<B> & Brand.Brand<Name>,
	B["sql"],
	DomainOf<B> & Brand.Brand<Name> & DeclaredDomain<Proved>,
	FactsOf<B> & DeclaredFacts<Proved>
> {
	(unbranded: Brand.Brand.Unbranded<Infer<B> & Brand.Brand<Name>>): Infer<B> & Brand.Brand<Name>
	readonly name: Name
	readonly base: B
}

/**
 * Not a field of a writing of its own, a serial generation declaration among them. A caller's descriptor carries no
 * `writing` member, so an absent optional `never` admits it and refuses a serial's, a drawn field's and an accumulated
 * field's. A contract's bases are NotSerialBases'.
 */
export interface NotSerial {
	readonly writing?: never
}

/**
 * A contract's base chain read down to its end: unknown where no base is a field of a writing of its own, never where
 * one is, at any depth, so a contract over a serial, or over a contract over one, is refused wherever a descriptor is
 * admitted as NotSerial.
 */
export type NotSerialBases<F> = F extends { readonly base: infer B }
	? B extends { readonly writing: WritingTag }
		? never
		: NotSerialBases<B>
	: unknown

/**
 * Not a roster's descriptor: closedId(X) carries its roster under `roster`, which an absent optional `never` refuses,
 * so a member of a roster is X.handle(member). A contract over a closedId carries its base, never a roster, and passes.
 */
export interface NotRoster {
	readonly roster?: never
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

/**
 * Span endpoints: the integer ones (IntegerLike), date and a contract over date, whose host is a CalendarDate, branded
 * or not.
 */
export type SpanEndpointLike = IntegerLike | Field<CalendarDate, "date">

/**
 * A span's width over endpoints of host type E, upper - lower: a count of days, a JavaScript integer, over dates; a
 * value of the endpoint's base type otherwise.
 */
export type SpanWidthOf<E> = [BaseOf<E>] extends [CalendarDate] ? number : BaseOf<E>

/**
 * A closed reference: one of the roster's handles, stored as its code under the roster's domain, whose domain is its
 * handles under the roster's identity (Rostered), so two rosters of one member set never meet.
 */
export interface ClosedIdField<out C> extends Field<
	HandleOf<C>,
	"code",
	HandleOf<C> & Rostered<RosterName<C>>
> {
	readonly roster: C
}

/**
 * A set over a roster: bit(n), one bit per code the roster has minted, holes included. Its host value is Bits<C>, and
 * its domain the same, so a set over one roster never meets a set over another.
 */
export interface BitsField<out C> extends Field<Bits<C>, "bits", Bits<C>> {
	readonly roster: C
}

/** A set of a roster's handles, branded by the roster: a set over one roster is never one over another. */
export type Bits<C> = ReadonlySet<HandleOf<C>> & Rostered<RosterName<C>>

/**
 * A field no insert's head holds: one that states under `writing` that PostgreSQL or grizzle writes it. A serial is
 * written by its sequence, and an addition supplies all of its relation's serials or none (SerialFieldsOf), so it is
 * none of these.
 */
export interface UnwrittenField {
	readonly writing: Exclude<WritingTag, "serial">
}

/** A natural grizzle draws: a family's index or count, or a tree's start or end. In a Fact, never in an Addition. */
export interface DrawnField extends NaturalField, UnwrittenField {
	readonly writing: "drawn"
}

/**
 * A header's retirement field: a boolean PostgreSQL defaults to false when its row is inserted, and the retirement of its
 * group sets to true for good (schema/relation.ts retirementField). In a Fact, never in an Addition.
 */
export interface RetirementField extends Field<boolean, "boolean">, UnwrittenField {
	readonly writing: "retirement"
}

/**
 * A field grizzle fills on the host from `start` at its axis's base, of the declared type F: a fold's accumulator or a
 * copy along a family axis. In a Fact, never in an Addition.
 */
export interface AccumulatedField<out F extends FieldBase>
	extends
		Built,
		UnwrittenField,
		Domained<DomainOf<F>>,
		Proving<FactsOf<F>>,
		Languaged<LanguageOf<F>> {
	readonly writing: "accumulated"
	readonly field: F
	readonly column: F["column"]
	readonly sql: F["sql"]
}

/**
 * A field PostgreSQL writes from its row (relation.generated): a STORED generated column of the declared type F. It
 * carries F's column, SQL type, domain, facts and language, so it is read as every field of F is; it is no descriptor a
 * builder made (no Built brand), so no contract, span, closed id, cast or parameter takes it as a type.
 */
export interface GeneratedField<out F extends FieldBase>
	extends UnwrittenField, Domained<DomainOf<F>>, Proving<FactsOf<F>>, Languaged<LanguageOf<F>> {
	readonly writing: "generated"
	readonly type: F
	readonly column: F["column"]
	readonly sql: F["sql"]
}

/** A roster's name, its identity, read from its `name` member. */
export type RosterName<C> = C extends {
	readonly kind: "closed"
	readonly name: infer N extends string
}
	? N
	: never

/** The roster handles of a roster, read from its `handles` member. */
export type HandleOf<C> = C extends {
	readonly kind: "closed"
	readonly handles: ReadonlyArray<infer H>
}
	? H
	: never
