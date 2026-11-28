import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { Brand } from "effect"
import type { HostKeysOf, Marked } from "#compiler/core/brand.ts"
import type { Column, FieldHost } from "#compiler/core/decoder.ts"
import type {
	Built,
	Domained,
	domain,
	FieldMarked,
	Generating,
	Languaged,
	language,
	Proving
} from "#compiler/core/phantom.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import type { Instant } from "#compiler/scalar/instant.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { NumericHostOf } from "#compiler/scalar/values/convert.ts"
import type { Numeric } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Sha256 } from "#compiler/scalar/values/sha256.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import type {
	CallArgs,
	CallNumberings,
	CallReads,
	CallSource
} from "#compiler/types/compute/call.ts"
import type { ValueOperand } from "#compiler/types/compute/scalar.ts"
import type {
	BaseOf,
	BindMapParams,
	Predicate,
	DeclaresAll,
	DomainOf,
	Facts,
	FactsOf,
	LanguageOf,
	Refusal,
	RosterBrands,
	Rostered,
	Varianted,
	ComputedOrigin,
	InputTerm,
	OperandOrigin,
	ParamsOfTerm,
	Term,
	TermBase
} from "#compiler/types/core/phantom.ts"
import type { VariantSpelling } from "#compiler/types/schema/function.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"
import type { RowScalars, Shows } from "#compiler/types/schema/statements.ts"

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
 * The exact carriers: Numeric holds PostgreSQL numeric exactly and is never a JavaScript number; Money holds the
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
export type ByteaField = Field<Uint8Array<ArrayBuffer>, "bytea">

/**
 * exactInteger: an integer of any size, the type integer arithmetic delivers, its host type bigint and its SQL type the
 * exact integer's, so a term of it meets every exact integer and the plain integers as arithmetic's does, and a query's
 * exact integer is written into it as it is (scalar/exact.ts).
 */
export type ExactIntegerField = Field<bigint, "exact integer">

/**
 * exactMoney: an amount of money of any size, the type money arithmetic and a money sum deliver, its host type Money and
 * its SQL type exact money's, so a term of it meets exact money and plain money as arithmetic's does, and a query's
 * exact money is written into it as it is (scalar/exact.ts).
 */
export type ExactMoneyField = Field<Money, "exact money">

/**
 * The SQL types of storage alone, the type level's reading of a capability set of storage only (scalar/registry.ts
 * storedOnly): the SQL types of the stored-only fields, bytes the one such field. A value of one is written and read back
 * whole, so no key, side, computation, parameter, filter, contract or written-by-PostgreSQL field takes one.
 */
export type StoredOnlySql = ByteaField["sql"]

/**
 * The refusal of a descriptor or term of SQL type Sql where it is stored only (StoredOnlySql), which no key, rule,
 * computation, parameter, filter, contract or written-by-PostgreSQL field takes; nothing for any other.
 */
export type NotStoredOnly<Sql> = [Sql] extends [StoredOnlySql]
	? Refusal<"bytea is stored only, written and read back whole: no key, rule, computation, parameter or filter reads them">
	: unknown

/** A contract's base that is no digest, whose one predicate is its length, which its domain holds (ir/scalar.ts DigestType). */
export type NotDigest<Sql> = [Sql] extends ["sha256"]
	? Refusal<"a digest is never a domain's base: its one predicate is its length, which its domain holds">
	: unknown

/**
 * The refusal of a descriptor of SQL type Sql where it is a search document's, tsvector, which PostgreSQL alone makes
 * and a field holds as a read delivered it (tsvector), so no parameter, relation parameter's column or contract's
 * base is of it; nothing for any other.
 */
export type NotSearchDocument<Sql> = [Sql] extends ["tsvector"]
	? Refusal<"a search document is PostgreSQL's parse of texts, which a field holds as a read delivered it: no parameter or domain is of its type">
	: unknown

/**
 * Whether a column's type is a bare uuid: of SQL type uuid, its values every Uuid, with no brand, which a contract over
 * uuid gives them (Domain), so no contract names whose id it holds.
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
		? Refusal<'say whose id this is: domain<typeof key>()("ClerkUserId", uuid)'>
		: unknown
}

/** The refusal of a column type that is a bare uuid (BareUuid), nothing for any other. */
export type NamedId<F> =
	BareUuid<F> extends true
		? Refusal<'say whose id this is: domain<typeof key>()("ClerkUserId", uuid)'>
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
 * numeric: PostgreSQL's numeric of no typmod, every value numeric holds, its host type Numeric, which is also the one
 * call numeric(p, s), precision and scale both declared, whose host type is its scale's (NumericHostOf): a bigint at
 * scale 0, a Numeric at any other, and whose member numeric.within(digits, scale) is numeric of no typmod within a
 * computed numeric's bound (NumericBoundField). PostgreSQL's numerictypmodin rule is checked at runtime (ir/carriers.ts
 * numericMaxPrecision, numericMinScale and numericMaxScale).
 */
export type NumericField = Field<Numeric, "numeric"> &
	(<const S extends number>(
		precision: number,
		scale: S
	) => NumericTypmodField<NumericHostOf<S>>) & {
		readonly within: (digits: number, scale: number) => NumericBoundField
	}

/**
 * numeric.within(digits, scale): numeric of no typmod within a computed numeric's bound, NaN, an infinity or a finite
 * value below 10^digits in magnitude of at most `scale` fraction digits, the type a stored field of a sum's, a mean's
 * or an operation's value is of exactly. Its host type and domain are numeric's, Numeric, so its terms meet every
 * numeric's; its bound is a runtime value only.
 */
export interface NumericBoundField extends Field<Numeric, "numeric"> {
	readonly bound: { readonly digits: number; readonly scale: number }
}

/**
 * numeric(p, s), its precision and scale both declared, its host type its scale's (NumericHostOf). Its domain is
 * numeric's whatever its host, Numeric, so its terms meet every numeric's and take a numeric's literals; precision and
 * scale are runtime values only.
 */
export interface NumericTypmodField<Host extends Numeric | bigint = Numeric | bigint> extends Field<
	Host,
	"numeric",
	Numeric
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
	"int8",
	NaturalDomain,
	{ readonly nonnegative: true }
> {
	readonly natural: true
}
/** An instant's host value, a bigint a read's column alone brands (scalar/instant.ts). */
export type { Instant } from "#compiler/scalar/instant.ts"

/**
 * The identity an instant's terms meet at: a bigint of the database's clock, the domain of the builtin contract
 * `instant` over int8, proved nonnegative, a name no other contract takes (OneDomainName), so an instant meets
 * only instants, never a count, a caller's bigint or a contract over one. Its values are Instant, the bigints a read
 * delivers (InstantField).
 */
export type InstantDomain = Instant & DeclaresAll<"nonnegative">

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
			? Refusal<"an instant is the database's clock's alone: no parameter, literal, constant, cast, domain or range is of its type">
			: unknown

/**
 * instant.stored: a field of instant's type its caller writes as it is, a copy of an instant a read delivered, which the
 * database draws nothing of. Its host type is Instant, so a host writes only an instant it read, never a bigint of its
 * own; its domain is InstantDomain, so a term of it meets only another instant's, and no parameter, literal, cast,
 * contract or span is of its type (NotInstant).
 */
export type StoredInstantField = Field<
	Instant,
	"int8",
	InstantDomain,
	{ readonly nonnegative: true }
>

/**
 * instant: microseconds since the Unix epoch on the database's clock, installed as natural is. No caller writes one: an
 * insert stamps its relation's clock, or states a stored instant into a reference, as the schema's laws say which a
 * field is (analysis/theory/instants.ts); no parameter, literal or cast is of its type, so no value a caller holds
 * reaches one. Its host type is Instant, as a read delivers it; its domain is InstantDomain, so a term of it meets only
 * another instant's, and `Type.base` reads one as the bigint it is. `instant: true` is the member its type is told apart
 * by from instant.stored's, `stored`, the one field of its type its caller writes.
 */
export interface InstantField extends StoredInstantField {
	readonly instant: true
	readonly stored: StoredInstantField
}

/**
 * How a field is written, as its descriptor's type states it under `writing`; a caller's field carries none.
 * generated: by PostgreSQL from its row; drawn: by grizzle from the nested arrays its caller writes; accumulated: by
 * grizzle on the host, proved by PostgreSQL; place: by the insert that adds its row, one past its group's greatest place.
 */
export type WritingTag = "generated" | "drawn" | "accumulated" | "place"

/**
 * A span's width is upper - lower, a value of the endpoint's base type: over a contract
 * endpoint such as span(Cents, 15n) it is a bare bigint, not a Cents; for every unbranded
 * endpoint that is the endpoint type itself. BaseOf is a conditional type, so the variance is measured rather than
 * annotated: a RangeField is covariant in its endpoint exactly where BaseOf is. Its host is the span of its endpoint's
 * host, Endpoint, and its domain the span of its endpoint's domain, EndpointDomain: over a contract, the contract's
 * domain with the facts it declares, so a span over Cents meets a point of Cents (r.pointIn) as the engine does.
 */
export interface RangeField<Endpoint, EndpointDomain> extends Field<
	Span<Endpoint>,
	"range",
	Span<EndpointDomain>
> {
	readonly width?: RangeWidthOf<Endpoint>
}

/**
 * A literal compared with a term of language T. Over Numeric it is a Numeric, a bigint, or an exact decimal string
 * checked at construction; a JavaScript number is never a numeric literal; and nothing over an instant, which is the
 * database's alone. A literal compared with a contract's term is a value of the contract's base, its host type
 * unmarked (BaseOf): a comparison makes no value of the contract, so `r.eq(score, 0.5)` forges nothing. Without BaseOf,
 * `T extends Numeric ? Numeric | bigint | string : T` would make `r.eq(cents, 5n)` fail to typecheck.
 */
export type LiteralOf<T> = [T] extends [InstantDomain]
	? never
	: BaseOf<T> extends infer B
		? B extends Numeric
			? Numeric | bigint | string
			: B
		: never

/**
 * A literal that becomes a value of a type of language T: a typed constant's (Type.literal), a conditional's other arm
 * and a variant arm's field. Over a host type a consumer marks (core/brand.ts Marked), a contract's, it is a literal of
 * its base under the consumer's keys, which only the consumer's mint makes, `toCents(5n)`, so no program makes a value
 * of the contract from a value of its base; over any other type it is the literal a comparison takes (LiteralOf).
 */
export type ValueLiteralOf<T> = [HostKeysOf<T>] extends [never]
	? LiteralOf<T>
	: Marked<LiteralOf<T>, Extract<HostKeysOf<T>, symbol>>

export type Infer<F> = FieldHost<F>
export type SqlOf<F> = F extends Field<unknown, infer Sql> ? Sql : never

/**
 * The key a consumer's contract F holds beyond its base's, its own (Domain K), which a contract over another holds
 * apart from its base's (types/fields KeyApart); never for any other type, natural and instant among them, whose values
 * no consumer owns.
 */
export type OwnKeyOf<F> = F extends { readonly base: infer B }
	? Exclude<HostKeysOf<Infer<F>>, HostKeysOf<Infer<B>>>
	: never

/**
 * The keys a database-side mint into F takes, every key F's host type is marked by: its own key, then its base's, down
 * its chain, one for each consumer's contract of it, as the host makes a value of F only through each of their mints
 * (`toOuter(toCents(0n))`); none for a type no consumer owns.
 */
export type MintKeys<F> = F extends { readonly base: infer B }
	? [OwnKeyOf<F>] extends [never]
		? MintKeys<B>
		: readonly [key: OwnKeyOf<F>, ...MintKeys<B>]
	: readonly []

/**
 * What a database-side mint into F takes after its own arguments, Type.cast's, drawn's and accumulated's: F's keys
 * (MintKeys), as mintOf takes each on the host, so a module that does not hold them makes no value of the contract in a
 * query, a cast or a field grizzle fills; nothing for any other type the types know; and any keys for a field of a host
 * type they do not, a generic caller's, which the field's own descriptor judges (scalar/contract.ts admitMintKey).
 */
export type MintKey<F> =
	MintKeys<F> extends readonly []
		? unknown extends Infer<F>
			? ReadonlyArray<symbol>
			: readonly []
		: MintKeys<F>

/** The facts a contract declares: each named fact proved; none declared is the empty declaration. */
export type DeclaredFacts<Proved extends ReadonlyArray<keyof Facts>> = {
	readonly [K in Proved[number]]: true
}

/** What a contract's domain carries of the facts it declares: one Declares per fact, nothing where it declares none. */
type DeclaredDomain<Proved extends ReadonlyArray<keyof Facts>> = [Proved[number]] extends [never]
	? unknown
	: DeclaresAll<Proved[number]>

/**
 * A nominal contract: base descriptor, optional total predicate, PostgreSQL domain. Its host type is its base's under
 * its consumer's key K (core/brand.ts Marked), so a write of it, a fact's field, a parameter's argument or a closed
 * row's, takes only a value the key's mint made (mintOf), and a read delivers one through its column, the one
 * conversion grizzle makes unchecked, since it trusts its own database (core/decoder.ts hostColumn). It is no function:
 * no value of it is made but by its consumer. The database checks its base type and its predicate on every write. Its
 * values have its base's facts and the facts it declares its predicate proves (Proved), which compilation proves from
 * the predicate; its domain, its identity, is its base's under its name, with the declared facts (Declares), so two
 * contracts over one base are distinct types and every value of its type has its facts, read from a query's heading
 * too.
 */
export interface Domain<
	Name extends string,
	B extends FieldBase,
	K extends symbol,
	Proved extends ReadonlyArray<keyof Facts> = readonly []
> extends Field<
	Marked<Infer<B>, K>,
	B["sql"],
	DomainOf<B> & Brand.Brand<Name> & DeclaredDomain<Proved>,
	FactsOf<B> & DeclaredFacts<Proved>
> {
	readonly name: Name
	readonly base: B
}

/** Any consumer's contract, whatever its name, base, key and declared facts. */
export type AnyDomain = Domain<string, FieldBase, symbol>

/**
 * Not a field of a writing of its own. A caller's descriptor carries no `writing` member, so an absent optional `never`
 * admits it and refuses a drawn field's, an accumulated field's and a generated field's. A
 * contract's base is one (types/fields DomainConstructor), so no contract's chain holds a field of a writing of its
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
 * Span endpoints: int4, int8 and contracts over them. A contract over
 * int8 is a Field<bigint & Brand, "int8">, and Field is covariant in its host type, so the two plain arms admit
 * every contract over an admitted base. int2 is no endpoint.
 */
export type IntegerLike = PlainIntegerField<number, "int4"> | PlainIntegerField<bigint, "int8">

/**
 * Span endpoints: the integer ones (IntegerLike), date and a contract over date, whose host is a CalendarDate, branded
 * or not.
 */
export type RangeEndpointLike = IntegerLike | Field<CalendarDate, "date">

/**
 * A span's width over endpoints of host type E, upper - lower: a count of days, a JavaScript integer, over dates; a
 * value of the endpoint's base type otherwise.
 */
export type RangeWidthOf<E> = [BaseOf<E>] extends [CalendarDate] ? number : BaseOf<E>

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
 * A variant's arms as its constructor takes them (types/fields/constructors.ts VariantConstructor): one per handle of
 * the subset of its roster's handles the variant holds, every handle or some, each a record of its fields, each a
 * caller's descriptor. A handle no arm names is no value of the variant (ArmHandles).
 */
export type VariantArms<C> = {
	readonly [H in HandleOf<C> & string]?: Readonly<Record<string, FieldBase & NoWriting>>
}

/**
 * The handles a variant of `Arms` over the roster C holds, its arms' (VariantArms): the subset of C's handles its tag
 * takes, as a closed id of that subset holds them (ClosedIdField S).
 */
export type ArmHandles<C, Arms> = keyof Arms & HandleOf<C>

/**
 * One arm's value: its handle under `tag`, and each of its fields' host values under its name, one object type, as a
 * reader's editor shows it.
 */
export type ArmValue<H extends string, Fields> = {
	readonly [K in "tag" | keyof Fields]: K extends "tag"
		? H
		: K extends keyof Fields
			? Infer<Fields[K]>
			: never
}

/**
 * A variant's host value, a TypeScript tagged union: one arm's handle under `tag`, and that arm's fields' host values,
 * what its column delivers and a write takes (scalar/values/identity.ts VariantValue).
 */
export type VariantValueOf<Arms> = {
	[H in keyof Arms & string]: ArmValue<H, Arms[H]>
}[keyof Arms & string]

/**
 * A variant (ir/scalar.ts VariantType): a typed sum of `Arms`, one per handle of a subset of the roster C's handles,
 * every handle or some (ArmHandles), named Name. Its host type and language are its tagged union over those arms alone
 * (VariantValueOf); its domain is the union under its name's identity (Varianted), so a field of it meets only another
 * of the same variant. `name`, `roster` and `arms` are the values its constructor was given.
 */
export interface VariantField<Name extends string, C, Arms> extends Field<
	VariantValueOf<Arms>,
	"variant",
	VariantDomain<Name, Arms>
> {
	readonly name: Name
	readonly roster: C
	readonly arms: Arms
	/**
	 * The tag of a value of the variant: the handle of the arm the value holds, a closed id of the subset of its roster
	 * its arms name (ArmHandles), its domain and language the roster's, as closedId(C, { only }) is.
	 */
	readonly tag: <PA, OA>(
		value: InputTerm<VariantDomain<Name, Arms>, PA, OA, "variant">
	) => Term<
		HandleOf<C> & RosterBrands<RosterName<C>, OrderOf<C>>,
		PA,
		ComputedOrigin<OA>,
		"code",
		ArmHandles<C, Arms>,
		Facts,
		HandleOf<C>
	>
	/**
	 * The identity image of a value of the variant (scalar/variant-digest.ts): the SHA-256 of its arm's handle's digest
	 * and each of its fields' fixed-width images, so two values have one digest exactly where they are of one arm and
	 * each field is one value by its bytes: texts by their UTF-8, floats by their bits, -0 apart from 0 and every NaN
	 * one. `generated(sha256, V.digest(row.value))` is a field a key may be declared over, whatever text an arm holds.
	 */
	readonly digest: <PA, OA>(
		value: InputTerm<VariantDomain<Name, Arms>, PA, OA, "variant">
	) => Term<Sha256, PA, ComputedOrigin<OA>, "sha256">
	/**
	 * The fields of the arm `handle` of `value`, a source a rule matches as it matches a call's rows (r.rest's kind): one
	 * fact of the arm's fields, each at its own type, where `value`'s tag is that arm, none where it is another, so
	 * `r.match(V.arm(cell, h), { field })` keeps the bindings whose cell holds arm h, its fields bound. `value` is a term
	 * of the variant, a parameter or a typed constant; an arm of no field has no source, its tag compared instead.
	 */
	readonly arm: <
		const X extends CallArgs<{ readonly value: VariantField<Name, C, Arms> }>["value"],
		const H extends ArmsWithFields<Arms>
	>(
		value: X,
		handle: H
	) => CallSource<
		FactOfFields<Arms[H]>,
		BindMapParams<{ readonly value: X }>,
		Arms[H],
		CallReads<{ readonly value: X }>,
		CallNumberings["arm"]
	>
	/** In a declared function's body (fn.body): the code of the arm `handle`, which `(v).tag` holds for a value of it. */
	readonly code: (handle: keyof Arms & string) => VariantSpelling
	/** In a declared function's body (fn.body): the attribute of the composite the arm `handle`'s field `field` is. */
	readonly attribute: <const H extends keyof Arms & string>(
		handle: H,
		field: keyof Arms[H] & string
	) => VariantSpelling
	/**
	 * In a declared function's body (fn.body): a value of the arm `handle`, `fields` exactly its fields, each the SQL text
	 * of its value; every other arm absent, cast to the variant's domain, which judges it.
	 */
	readonly of: <const H extends keyof Arms & string>(
		handle: H,
		fields: { readonly [F in keyof Arms[H]]: string }
	) => VariantSpelling
	/** A value of the arm `handle`, each of its fields a term of the field's type or a literal of it. */
	readonly make: <const H extends keyof Arms & string, const Fs extends ArmOperands<Arms[H]>>(
		handle: H,
		fields: Fs
	) => Term<
		VariantDomain<Name, Arms>,
		ParamsOfTerm<Fs[keyof Fs]>,
		ComputedOrigin<OperandOrigin<Fs[keyof Fs]>>,
		"variant",
		VariantValueOf<Arms>,
		Facts,
		VariantValueOf<Arms>
	>
	/**
	 * One term per arm, exhaustive: a handler for every arm, each given the arm's fields of `value` as terms, its value
	 * where `value`'s tag is that arm.
	 */
	readonly cases: <
		PA,
		OA,
		const R extends {
			readonly [H in keyof Arms & string]: (arm: ArmTerms<Arms[H], PA, OA>) => unknown
		}
	>(
		value: InputTerm<VariantDomain<Name, Arms>, PA, OA, "variant">,
		handlers: R
	) => Extract<ReturnType<R[keyof R]>, TermBase>
}

/**
 * A variant's checks (variant's fourth argument): at most one predicate per arm with a field, each given that arm's
 * fields as terms beside the row helpers a row check compares them with (RowScalars), reading nothing else.
 */
export type ArmChecks<Name extends string, Arms> = {
	readonly [H in ArmsWithFields<Arms>]?: (
		arm: RowScalars<Shows<`${Name}.${H}`, Arms[H]>>
	) => Predicate<never>
}

/** The handles of the arms of `Arms` that hold a field: those V.arm reads a source of. */
export type ArmsWithFields<Arms> = {
	readonly [H in keyof Arms & string]: keyof Arms[H] extends never ? never : H
}[keyof Arms & string]

/** The identity a variant's terms meet at: its tagged union under its name's identity (Varianted). */
export type VariantDomain<Name extends string, Arms> = VariantValueOf<Arms> & Varianted<Name>

/** The SQL type of a descriptor. */
type SqlOfField<F> = F extends { readonly sql: infer S extends SqlTag } ? S : never

/**
 * What make takes for each field of an arm: a term of the field's type, or a literal that becomes a value of it
 * (ValueOperand), a contract's host value among them.
 */
export type ArmOperands<Fields> = {
	readonly [F in keyof Fields]: ValueOperand<
		DomainOf<Fields[F]>,
		SqlOfField<Fields[F]>,
		LanguageOf<Fields[F]>
	>
}

/** What a cases handler is given of its arm: each field a term of its own type, read of the subject. */
export type ArmTerms<Fields, P, O> = {
	readonly [F in keyof Fields]: Term<
		DomainOf<Fields[F]>,
		P,
		ComputedOrigin<O>,
		SqlOfField<Fields[F]>,
		Infer<Fields[F]>,
		FactsOf<Fields[F]>,
		LanguageOf<Fields[F]>
	>
}

/**
 * A set over a roster: bit(n), one bit per code the roster has minted, holes included. Its host value is Bits<C>, and
 * its domain the same, so a set over one roster never meets a set over another.
 */
export interface BitField<out C> extends Field<Bits<C>, "bit", Bits<C>> {
	readonly roster: C
}

/** A set of a roster's handles, branded by the roster: a set over one roster is never one over another. */
export type Bits<C> = ReadonlySet<HandleOf<C>> & Rostered<RosterName<C>>

/** A field no insert's head holds: one that states under `writing` that PostgreSQL or grizzle writes it. */
export interface UnwrittenField {
	readonly writing: WritingTag
}

/**
 * The refusal of a type grizzle draws no value of, nothing for one it does (DrawnField): natural, or a contract whose
 * base is an integer, int2, int4 or int8, whose own CHECK bounds every value drawn into it.
 */
export type DrawnType<F> = [F] extends [NaturalField]
	? unknown
	: [F] extends [
				{
					readonly name: string
					readonly base: FieldBase
					readonly sql: "int2" | "int4" | "int8"
				}
		  ]
		? unknown
		: Refusal<"drawn(type): natural or a domain over an integer, the types a family's index and count are of">

/**
 * A value of the type F grizzle draws, natural or a contract over an integer (DrawnType): a family's index or count, or
 * a tree's start or end. Its column, SQL type, domain, facts and language are F's, so a contract's is read and paired
 * as every field of the contract is, and `field` is F, a natural's telling a field pred reads (NaturalIn). In a Fact,
 * never in an Addition.
 */
export interface DrawnField<out F extends FieldBase = NaturalField>
	extends
		Built,
		FieldMarked,
		UnwrittenField,
		Domained<DomainOf<F>>,
		Proving<FactsOf<F>>,
		Languaged<LanguageOf<F>> {
	readonly writing: "drawn"
	readonly field: F
	readonly column: F["column"]
	readonly sql: F["sql"]
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
 * builder made (no Built brand), so no contract, span, closed id, cast or parameter takes it as a type. O is the origin
 * of its term, the fields of its row it reads (Generating), the one carrier of what a generation reads at the type
 * level: unknown where no term's origin is traced, a field of any reads.
 */
export interface GeneratedField<out F extends FieldBase, out O = unknown>
	extends
		UnwrittenField,
		Domained<DomainOf<F>>,
		Proving<FactsOf<F>>,
		Languaged<LanguageOf<F>>,
		Generating<O> {
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
