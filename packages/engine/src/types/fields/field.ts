import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { Brand } from "effect"
import type { Column, FieldHost } from "#compiler/core/decoder.ts"
import type {
	Built,
	Domained,
	domain,
	FieldMarked,
	Languaged,
	language,
	Proving
} from "#compiler/core/phantom.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { NumericHostOf } from "#compiler/scalar/values/convert.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import type {
	BaseOf,
	DeclaresAll,
	DomainOf,
	Facts,
	FactsOf,
	LanguageOf,
	Refusal,
	RosterBrands,
	Rostered
} from "#compiler/types/core/phantom.ts"

/**
 * Any descriptor: the members every runtime descriptor has, its PostgreSQL type name and its column, and the domain
 * and language it states, which are any for a descriptor of unknown type: a variable minted over one is of unknown
 * type, never of none.
 */
export interface FieldBase extends Built, FieldMarked, Domained<unknown>, Languaged<unknown> {
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

/**
 * Whether a column's type is a bare uuid: of SQL type uuid, its values every Uuid, with no brand, which a contract over
 * uuid gives them (Contract), so no contract names whose id it holds.
 */
type BareUuid<F> = [F] extends [{ readonly sql: "uuid" }]
	? [Uuid] extends [FieldHost<F>]
		? true
		: false
	: false

/**
 * The refusal of each column of `Fields` that is a bare uuid (BareUuid), nothing for any other: an id says whose it is,
 * a contract over uuid, so a Clerk user's id is never written where a Stripe customer's belongs (scalar/minted.ts
 * unnamedIdRefusal, which the relation builders refuse at run time).
 */
export type NamedIds<Fields> = {
	readonly [K in keyof Fields]: BareUuid<Fields[K]> extends true
		? Refusal<'say whose id this is: contract("ClerkUserId", uuid)'>
		: unknown
}

/** The refusal of a column type that is a bare uuid (BareUuid), nothing for any other. */
export type NamedId<F> =
	BareUuid<F> extends true
		? Refusal<'say whose id this is: contract("ClerkUserId", uuid)'>
		: unknown

/**
 * A field descriptor: its host type, what its column delivers and a write takes; its SQL type; its domain, the identity
 * it meets other types by; its facts; and its language, every value a JavaScript value standing at it or opposite its
 * term is one of, its host type's but for a closed id of a subset, whose language is its roster's (ClosedIdField).
 */
export interface Field<
	out Host,
	out Sql extends SqlTag,
	out D = Host,
	out F extends Facts = Facts,
	out L = Host
>
	extends FieldBase, Proving<F> {
	readonly [domain]?: D | undefined
	readonly [language]?: L | undefined
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
 * str.pattern: a closed relation's text of Text.matches patterns, its host type and domain text, which a pattern
 * term meets as it meets any text.
 */
export type PatternField = Field<string, "text">

/** The host type of numeric(p, s) at a scale S (scalar/values/convert.ts). */
export type { NumericHostOf }

/**
 * numeric(p, s), its precision and scale both declared, as every numeric field is, its host type its scale's
 * (NumericHostOf). Its domain is numeric's whatever its host, Decimal, so its terms meet every numeric's and take a
 * numeric's literals; precision and scale are runtime values only.
 */
export interface NumericTypmodField<Host extends Decimal | bigint = Decimal | bigint> extends Field<
	Host,
	"numeric",
	Decimal
> {
	readonly precision: number
	readonly scale: number
}

/**
 * natural's identity, its terms' domain: a bigint its type declares nonnegative, unbranded, so a natural meets a
 * natural, a count among them, and no bigint, as the checker types them (scalar/aggregate.ts countOverload), and a
 * column of it, a count's included, carries the fact wherever a query reads it (ColumnFacts).
 */
export type NaturalDomain = bigint & DeclaresAll<"nonnegative">

/**
 * natural: a bigint never below zero, which its values are proved to be, the type of every count, and the one field
 * type a law side may read pred of. Its host type is bigint, unbranded; its domain is NaturalDomain, and `natural` is
 * the member that tells it from every other bigint field.
 */
export interface NaturalField extends Field<
	bigint,
	"bigint",
	NaturalDomain,
	{ readonly nonnegative: true }
> {
	readonly natural: true
}
/**
 * The identity an instant's terms meet at: a bigint of the database's clock, the domain of the builtin contract
 * `instant` over pg.bigint, proved nonnegative, a name no other contract takes (OneContractName), so an instant meets
 * only instants, never a count, a caller's bigint or a contract over one. Its values are bigints: the brand is the
 * type's alone (InstantField).
 */
export type InstantDomain = bigint & Brand.Brand<"instant"> & DeclaresAll<"nonnegative">

/**
 * The refusal of a type of domain D where a caller states a value of it, a parameter, a relation parameter's column, a
 * literal or a typed constant, a cast's target, a contract's base or a span's endpoint: an instant's (InstantDomain),
 * which is the database's clock's alone; nothing for any other, nor for a domain the types do not know, `any` or
 * `never`, which states no instant.
 */
export type NotInstant<D> = [D] extends [never]
	? unknown
	: 0 extends 1 & D
		? unknown
		: [D] extends [InstantDomain]
			? Refusal<"an instant is the database's clock's alone: no parameter, literal, constant, cast, contract or span is of its type">
			: unknown

/**
 * instant: microseconds since the Unix epoch on the database's clock, installed as natural is. No caller writes one: an
 * insert stamps its relation's clock, or states a stored instant into a reference, as the schema's laws say which a
 * field is (analysis/theory/instants.ts); no parameter, literal or cast is of its type, so no value a caller holds
 * reaches one. Its host type is bigint, unbranded, as a read delivers it; its domain is InstantDomain, so a term of it
 * meets only another instant's, and `Type.base` reads one as the bigint it is. `instant: true` is the member its
 * type is told apart by.
 */
export interface InstantField extends Field<
	bigint,
	"bigint",
	InstantDomain,
	{ readonly nonnegative: true }
> {
	readonly instant: true
}

/**
 * How a field is written, as its descriptor's type states it under `writing`; a caller's field carries none.
 * generated: by PostgreSQL from its row; drawn: by grizzle from the nested arrays its caller writes; accumulated: by
 * grizzle on the host, proved by PostgreSQL; retirement: by its group's retirement; place: by the insert that adds its
 * row, one past its group's greatest place.
 */
export type WritingTag = "generated" | "drawn" | "accumulated" | "retirement" | "place"

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
 * JavaScript number is never a numeric literal; and nothing over an instant, which is the database's alone. A literal compared with or written into a contract
 * term adopts the contract, so the literal type is the unbranded base. Without
 * BaseOf, `T extends Decimal ? Decimal | bigint | string : T` would make `r.eq(cents, 5n)` fail to typecheck.
 */
export type LiteralOf<T> = [T] extends [InstantDomain]
	? never
	: BaseOf<T> extends infer B
		? B extends Decimal
			? Decimal | bigint | string
			: B
		: never

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
 * Not a field of a writing of its own. A caller's descriptor carries no `writing` member, so an absent optional `never`
 * admits it and refuses a drawn field's, an accumulated field's, a generated field's and a retirement field's. A
 * contract's base is one (types/fields ContractConstructor), so no contract's chain holds a field of a writing of its
 * own.
 */
export interface NoWriting {
	readonly writing?: never
}

/**
 * Not a roster's descriptor: closedId(X) carries its roster under `roster`, which an absent optional `never` refuses,
 * so a member of a roster is X.handle(member). A contract over a closedId carries its base, never a roster, and passes.
 */
export interface NotRoster {
	readonly roster?: never
}

/** A plain integer descriptor: an integer field of no writing of its own. */
type PlainIntegerField<Host, Sql extends SqlTag> = Field<Host, Sql> & NoWriting

/**
 * Span endpoints: pg.integer, pg.bigint and contracts over them. A contract over
 * pg.bigint is a Field<bigint & Brand, "bigint">, and Field is covariant in its host type, so the two plain arms admit
 * every contract over an admitted base. pg.smallint is no endpoint.
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
 * handles under the roster's identity (Rostered), so two rosters of one member set never meet, and, an unordered
 * roster's, under Unordered too, which no ordered operation reads (RosterBrands). Its host type is S, the handles it
 * holds, what its column delivers and an addition writes: every handle of the roster, or the subset closedId(C, { only })
 * or closedId(C, { except }) states (SubsetHandles). Its domain and its language are the roster's whatever S is, so a
 * closed id of a subset meets the whole roster: a closed id of it in a comparison, a join and a containment, as two
 * refined texts meet as text, and a handle of it in an equality, a selection and a set over the roster, which holds no
 * row where the handle is outside S.
 */
export interface ClosedIdField<out C, out S = HandleOf<C>> extends Field<
	S,
	"code",
	HandleOf<C> & RosterBrands<RosterName<C>, OrderOf<C>>,
	Facts,
	HandleOf<C>
> {
	readonly roster: C
}

/**
 * The subset of a roster's handles a closed id holds, stated once where the field is declared: `only` the handles it
 * lists, or every handle `except` the ones it lists, each list nonempty and each handle once.
 */
export type ClosedSubset<C> =
	| { readonly only: NonEmptyReadonlyArray<HandleOf<C>> }
	| { readonly except: NonEmptyReadonlyArray<HandleOf<C>> }

/** The handles a closed id over C holds under `subset`: every handle for none, `only`'s, or every one but `except`'s. */
export type SubsetHandles<C, Subset> = Subset extends {
	readonly only: ReadonlyArray<infer H extends HandleOf<C>>
}
	? H
	: Subset extends { readonly except: ReadonlyArray<infer H> }
		? Exclude<HandleOf<C>, H>
		: HandleOf<C>

/**
 * A set over a roster: bit(n), one bit per code the roster has minted, holes included. Its host value is Bits<C>, and
 * its domain the same, so a set over one roster never meets a set over another.
 */
export interface BitsField<out C> extends Field<Bits<C>, "bits", Bits<C>> {
	readonly roster: C
}

/** A set of a roster's handles, branded by the roster: a set over one roster is never one over another. */
export type Bits<C> = ReadonlySet<HandleOf<C>> & Rostered<RosterName<C>>

/** A field no insert's head holds: one that states under `writing` that PostgreSQL or grizzle writes it. */
export interface UnwrittenField {
	readonly writing: WritingTag
}

/** A natural grizzle draws: a family's index or count, or a tree's start or end. In a Fact, never in an Addition. */
export interface DrawnField extends NaturalField, UnwrittenField {
	readonly writing: "drawn"
}

/**
 * A row's place in its group, a natural the database stamps when an insert adds the row: one past the greatest place
 * its group holds, 0 for its first, so a group's places run gapless from 0 in the order its rows were inserted
 * (schema/relation.ts placeField). In a Fact, never in an Addition.
 */
export interface PlaceField extends NaturalField, UnwrittenField {
	readonly writing: "place"
}

/**
 * `place`: a place that states no order of stored rows, so a migration adds it only where each stored row stands alone in
 * its group; `place.by(field)` is the place whose stored rows a migration that adds it numbers in `field`'s order
 * (schema/relation.ts placeDescriptor).
 */
export interface PlaceDescriptor extends PlaceField {
	readonly by: (field: string) => PlaceField
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
		FieldMarked,
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

/** The order of a roster, read from its `order` member (ir/scalar.ts RosterOrder). */
export type OrderOf<C> = C extends {
	readonly kind: "closed"
	readonly order: infer O
}
	? O
	: never

/** The roster handles of a roster, read from its `handles` member. */
export type HandleOf<C> = C extends {
	readonly kind: "closed"
	readonly handles: ReadonlyArray<infer H>
}
	? H
	: never
