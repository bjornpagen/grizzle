import { sameOrder } from "#compiler/core/array.ts"
import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	canonicalTag,
	everyProperty,
	type TaggedValue
} from "#compiler/core/canonical.ts"
import { ownedDigest, type RosterDigest, rosterDigest } from "#compiler/core/fingerprint.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import type { Fact } from "#compiler/ir/proof.ts"

/**
 * The native carriers grizzle admits. range4, range8 and rangeDate are int4range, int8range and daterange,
 * the only span carriers; date is a calendar day; bytes is bytea, a value stored and read back whole (BytesType); there is
 * no timestamp, interval, JSON or array carrier. exactInteger and exactMoney are the exact arithmetic carriers
 * (ExactType), never a field's.
 */
export const carriers = [
	"int2",
	"int4",
	"int8",
	"numeric",
	"float4",
	"float8",
	"money",
	"bool",
	"uuid",
	"date",
	"text",
	"bytes",
	"code",
	"bits",
	"range4",
	"range8",
	"rangeDate",
	"vector",
	"exactInteger",
	"exactMoney"
] as const
export type Carrier = (typeof carriers)[number]

/** The exact arithmetic carriers: what integer and money arithmetic computes (ExactType). */
export type ExactValueCarrier = "exactInteger" | "exactMoney"

/**
 * Whether a column of each carrier holds few values, so that fixing it bounds no scan: a closed id holds one of a
 * roster's codes, a boolean one of two. A set over a roster holds one of 2^n sets, which bounds a scan as a text does. An index led by such a column narrows a lookup little, and a lookup that fixes
 * only such columns is no access path.
 */
export const fewValued: Readonly<Record<Carrier, boolean>> = {
	int2: false,
	int4: false,
	int8: false,
	numeric: false,
	float4: false,
	float8: false,
	money: false,
	bool: true,
	uuid: false,
	date: false,
	text: false,
	bytes: false,
	code: true,
	bits: false,
	range4: false,
	range8: false,
	rangeDate: false,
	vector: false,
	exactInteger: false,
	exactMoney: false
}

/** The serial generation names and the carrier each declares. */
export const serialCarriers = {
	smallserial: "int2",
	serial: "int4",
	bigserial: "int8"
} as const satisfies Readonly<Record<string, Carrier>>

/** The span carriers over integer endpoints, range4 over int4 and range8 over int8. */
export const integerSpanCarriers = ["range4", "range8"] as const satisfies ReadonlyArray<Carrier>

/** The span carriers: those over integer endpoints, and rangeDate over date endpoints. */
export const spanCarriers = [
	...integerSpanCarriers,
	"rangeDate"
] as const satisfies ReadonlyArray<Carrier>

/**
 * The operation capability vocabulary: storage, equality, ordering, hashing used for bucketing, the
 * aggregate overload families, span endpoints, expression-index eligibility, GiST, the set algebra of a set over a
 * roster (union, intersection, difference, cardinality, subset and disjointness, and the singleton of a closed id of
 * it), and the admitted extension operation. A CapabilitySet is sorted and duplicate-free, so its canonical form is
 * its identity.
 */
export const capabilities = [
	"avg",
	"boolAgg",
	"equality",
	"expressionIndex",
	"gist",
	"hashing",
	"minMax",
	"ordering",
	"setAlgebra",
	"spanEndpoint",
	"storage",
	"sum",
	"vectorDistance"
] as const
export type Capability = (typeof capabilities)[number]
export type CapabilitySet = ReadonlyArray<Capability>

export const capabilitySet = (caps: ReadonlyArray<Capability>): CapabilitySet =>
	Object.freeze([...new Set(caps)].toSorted(compareStrings))

/**
 * numeric(p, s): precision 1..numericMaxPrecision, scale numericMinScale..numericMaxScale, both always present, as every
 * numeric field, cast, parameter and typed literal declares them: one typmod, one identity.
 */
export interface NumericTypmod {
	readonly precision: number
	readonly scale: number
}

/**
 * What a computed numeric value is proved to be: every finite value below 10^digits in magnitude, with at most `scale`
 * fraction digits, within numeric's own limits, numericMaxIntegerDigits and numericMaxFractionDigits. Its digits are
 * negative for values below one by an order of magnitude or more, as a numeric(p, s) with s above p converts into one,
 * and never fewer than -numericMaxFractionDigits, below which no numeric value but zero lies. It is set where
 * the value is made, from what makes it: a sum's from its argument's and the rows' count, a mean's from its argument's
 * and PostgreSQL's display scale, an operation's from its operands' bounds. A making past numericMaxIntegerDigits is
 * ResourceBound there, so no bound passes it.
 */
export interface NumericBound {
	readonly digits: number
	readonly scale: number
}

/** vector(n): 1..vectorMaxDimensions dimensions (ir/carriers.ts). */
export interface VectorTypmod {
	readonly dims: number
}

/**
 * A nominal contract: a domain over its base with an optional predicate and the facts it proves. Compatibility is by
 * contract identity (name and base), never by predicate equality: sameScalarType ignores the predicate and the facts. The predicate
 * is the domain's one constraint, <contract>__check, an ExprTable in normal form (expr.ts predicateTable), so its
 * canonical text, which fingerprints include, does not depend on allocation order. The base is a value domain of the
 * contract's own carrier.
 * The name is a declared name, parsed where the contract is built (scalar/registry.ts contractOver) and where a
 * descriptor is decoded (scalar-shape.ts): the contract's identity as a type. Its domain is named by its physical
 * definition (core/identity.ts identity.contractDomain), which contracts of one definition share.
 */
export interface ContractInfo {
	readonly name: DeclaredName
	readonly base: ContractBase
	readonly predicate: ExprTable | undefined
	/**
	 * The facts every value of the contract has, which its declaration states and its build proved from its predicate
	 * (scalar/contract.ts): sorted, each once. A term of the contract carries them in its TypeScript type, so a divisor
	 * of a nonzero contract needs no guard.
	 */
	readonly facts: ReadonlyArray<Fact>
}

/**
 * The identity of a regex's language: the SHA-256 of the text analysis's canonical pattern key
 * (text/refinement.ts TextRefinement.digest). Two patterns are the same refinement exactly when their keys are equal.
 */
export type RegexKey = string & { readonly [regexKeyBrand]: true }
declare const regexKeyBrand: unique symbol
export const RegexKey = nominal<string, RegexKey>()

/**
 * Proved bounds on every member of a language, in code points and UTF-8 bytes. The analysis makes one by textBounds
 * alone, frozen where it is made.
 */
export interface TextBounds {
	readonly length: number
	readonly bytes: number
}

/** Bounds of `length` code points and `bytes` UTF-8 bytes: the one constructor of a TextBounds, frozen. */
export const textBounds = (length: number, bytes: number): TextBounds =>
	Object.freeze({ length, bytes })

/**
 * How PostgreSQL enforces a language of a text's patterns some admitted text value is no member of, with the bounds the
 * enforcement proves on every member: `VALUE IN (...)` of its members, at least one since an analyzed language has a
 * member, or `VALUE ~ '<ARE>'` of the translation of each pattern of the conjunction the check reads, joined by AND.
 * The text analysis chooses it (text/refinement.ts) and makes it by finiteCheck or regexCheck alone, so every one is
 * frozen with all it holds.
 */
export type PatternCheck =
	| {
			readonly kind: "finite"
			readonly members: NonEmptyReadonlyArray<string>
			readonly bounds: TextBounds
	  }
	| {
			readonly kind: "regex"
			readonly ares: NonEmptyReadonlyArray<string>
			readonly bounds: TextBounds | undefined
	  }

/** `VALUE IN (...)` of a finite language's `members`, a frozen copy of them: the one constructor of a finite check. */
export const finiteCheck = (
	members: NonEmptyReadonlyArray<string>,
	bounds: TextBounds
): PatternCheck => {
	const [first, ...rest] = members
	const copy: NonEmptyReadonlyArray<string> = [first, ...rest]
	return Object.freeze({ kind: "finite", members: Object.freeze(copy), bounds })
}

/**
 * `VALUE ~ '<ARE>'` of each ARE `ares` holds, one for each member of a conjunction its check reads, joined by AND: the
 * one constructor of a regex check, frozen.
 */
export const regexCheck = (
	ares: NonEmptyReadonlyArray<string>,
	bounds: TextBounds | undefined
): PatternCheck => Object.freeze({ kind: "regex", ares: Object.freeze(ares), bounds })

/**
 * How PostgreSQL enforces a text refinement: its pattern's language (PatternCheck), or a byte bound that cuts it,
 * `octet_length(VALUE) <= octets` beside the pattern's check, or alone where the pattern admits every value
 * (str.bytes), with the tighter of the pattern's bounds and the byte bound's, a code point taking at least a byte. A
 * byte bound's is made by octetsCheck alone, frozen.
 */
export type RegexCheck =
	| PatternCheck
	| {
			readonly kind: "octets"
			readonly octets: number
			readonly check: PatternCheck | undefined
			readonly bounds: TextBounds
	  }

/** The byte bound a check enforces beside its pattern's, str.bytes's: none for a pattern's check alone. */
export const octetsOf = (check: RegexCheck): number | undefined =>
	check.kind === "octets" ? check.octets : undefined

/** One pattern as a text declares it: its source in grizzle's grammar and its flags. */
export interface PatternSource {
	readonly source: string
	readonly flags: "u" | "su"
}

/**
 * A text's patterns, in declared order: a conjunction whose language is every text each member matches, the
 * intersection of the members' languages. str.regex declares one, str.and the members of each text it joins.
 */
export type Patterns = NonEmptyReadonlyArray<PatternSource>

/** A text's patterns as diagnostics name them: each `/source/flags`, joined by ` & ` as the host type joins them. */
export const patternsText = (patterns: Patterns): string =>
	patterns.map((p) => `/${p.source}/${p.flags}`).join(" & ")

/**
 * A regex refinement: its patterns as declared, its language's key and its enforcement, which the text analysis
 * computes where it builds the reference. The text package owns the pattern IR; the scalar type carries what every
 * later pass reads of it, so none analyzes the patterns again.
 */
export interface RegexRef {
	readonly patterns: Patterns
	readonly key: RegexKey
	readonly check: RegexCheck
}

/**
 * What the text analysis proved of a text descriptor's patterns, which the descriptor carries from where it is admitted
 * (text/refinement.ts textLanguage): every admitted value, a tautology, or a language some admitted value is no member
 * of, by its key and its enforcement. It is a function of the patterns beside it, so it is no part of the descriptor's
 * semantic identity (core/canonical.ts omitSourceLocs).
 */
export type TextLanguage =
	| { readonly kind: "every" }
	| { readonly kind: "refined"; readonly key: RegexKey; readonly check: RegexCheck }

/** A frozen copy of `patterns`, each member frozen: what a regex reference holds. */
const frozenPatterns = (patterns: Patterns): Patterns =>
	Object.freeze(mapNonEmpty(patterns, (p) => Object.freeze({ source: p.source, flags: p.flags })))

/** The text metadata a ScalarType carries for patterns of `language`: its regex reference and its proved bounds. */
export const textInfoOf = (patterns: Patterns, language: TextLanguage): TextInfo => {
	if (language.kind === "every") {
		return Object.freeze({ regex: "wildcard", lengthBound: undefined, byteBound: undefined })
	}
	const regex = Object.freeze({
		patterns: frozenPatterns(patterns),
		key: language.key,
		check: language.check
	})
	const bounds = language.check.bounds
	return Object.freeze(
		bounds === undefined
			? { regex, lengthBound: undefined, byteBound: undefined }
			: { regex, lengthBound: bounds.length, byteBound: bounds.bytes }
	)
}

/** The language a ScalarType's text metadata states: what a descriptor of that type carries. */
export const languageOfText = (text: TextInfo): TextLanguage =>
	text.regex === "wildcard"
		? Object.freeze({ kind: "every" })
		: Object.freeze({ kind: "refined", key: text.regex.key, check: text.regex.check })

/** The byte bound a text descriptor's language enforces beside its pattern's (octetsOf): none for an unrefined text. */
export const languageOctets = (language: TextLanguage): number | undefined =>
	language.kind === "every" ? undefined : octetsOf(language.check)

/** The pattern of every text as grizzle spells it: what a byte bound over every text cuts, `str.regex("^.*$", "su")`. */
export const wildcardPattern: PatternSource = Object.freeze({ source: "^.*$", flags: "su" })

/** The patterns a text type's language is stated by: its refinement's, or the wildcard's alone. */
export const textPatterns = (regex: RegexRef | "wildcard"): Patterns =>
	regex === "wildcard" ? [wildcardPattern] : regex.patterns

/**
 * The own language of a text's patterns, before a byte bound cuts it: every text, or the language their check
 * enforces, by its key. The text analysis proves one of a conjunction of patterns (text/refinement.ts textLookup).
 */
export type PatternLanguage =
	| { readonly kind: "every" }
	| { readonly kind: "refined"; readonly key: RegexKey; readonly check: PatternCheck }

/**
 * The key of a language whose canonical text is `text`: its SHA-256 under the regex-language domain. A pattern's text
 * is its canonical key (text/refinement.ts TextRefinement.key), and a cut's its pattern's key and its bound.
 */
export const languageKey = (text: string): RegexKey =>
	RegexKey(ownedDigest("regex-language", text, everyProperty))

/** The tighter of a pattern's bounds and a byte bound's: a code point takes at least a byte. */
const boundsWithin = (bounds: TextBounds | undefined, octets: number): TextBounds =>
	bounds === undefined
		? textBounds(octets, octets)
		: textBounds(Math.min(bounds.length, octets), Math.min(bounds.bytes, octets))

/**
 * `octet_length(VALUE) <= octets` beside a pattern's `check`, or alone where the pattern admits every value, with the
 * tighter bounds of the two (boundsWithin): the one constructor of a byte bound's check, frozen.
 */
const octetsCheck = (octets: number, check: PatternCheck | undefined): RegexCheck =>
	Object.freeze({ kind: "octets", octets, check, bounds: boundsWithin(check?.bounds, octets) })

/**
 * The language of a text of at most `octets` UTF-8 bytes whose pattern's own language is `pattern`, as str.bytes and a
 * guard of a text's bytes state it: the pattern's own where its bounds prove every member fits, so the two spell one
 * language, one key and one domain; else its members of at most so many bytes, enforced by `octet_length(VALUE) <=
 * octets` beside the pattern's check, or alone for every text, keyed by the pattern's own key and the bound, so a
 * language and a bound have one key however they are reached.
 */
export const languageWithin = (pattern: PatternLanguage, octets: number): TextLanguage => {
	if (pattern.kind === "every") {
		const every: TextLanguage = {
			kind: "refined",
			key: languageKey(`octets<=${octets}`),
			check: octetsCheck(octets, undefined)
		}
		return Object.freeze(every)
	}
	const { check } = pattern
	if (check.bounds !== undefined && check.bounds.bytes <= octets) {
		return pattern
	}
	const cut: TextLanguage = {
		kind: "refined",
		key: languageKey(`${pattern.key}&octets<=${octets}`),
		check: octetsCheck(octets, check)
	}
	return Object.freeze(cut)
}

/**
 * Every text descriptor carries regex metadata: a specific pattern or the canonical wildcard, and the bounds a specific
 * pattern proves on the value's length in code points and in UTF-8 bytes, which are proved together or not at all. The
 * wildcard admits every value, so it proves none.
 */
export type TextInfo =
	| { readonly regex: RegexRef; readonly lengthBound: number; readonly byteBound: number }
	| {
			readonly regex: RegexRef | "wildcard"
			readonly lengthBound: undefined
			readonly byteBound: undefined
	  }

/**
 * A closed roster: the closed relation's declared name and its distinct live handles in declared order, which is their
 * codes' order and so comparison order. The name is the roster's whole link to its domain and codes: the naming door
 * mints the roster's domain from it (core/identity.ts identity.rosterDomain), and the installation's codebook holds its
 * codes (ir/codes.ts), which no type holds, since they depend on the codes the installation held before.
 *
 * Its identity is its name and its handles in order, as type identity compares them (sameScalarType): one name holds
 * other handles in another schema, which a cursor, a snapshot or a migration compares this one's against. Its canonical
 * form (core/canonical.ts Canonicalizable) is its name and its handles' digest (core/fingerprint.ts rosterDigest), taken
 * once, where the roster is first made (Roster.of), so a type, a literal or a predicate over the roster encodes the same
 * characters whatever the roster's size, and every encoding of it changes with its handles.
 */
export class Roster implements Canonicalizable {
	readonly closed: DeclaredName
	readonly handles: NonEmptyReadonlyArray<string>
	readonly digest: RosterDigest

	/** The roster of `closed` over `handles`, its digest taken here (core/fingerprint.ts rosterDigest). */
	static of(closed: DeclaredName, handles: NonEmptyReadonlyArray<string>): Roster {
		return new Roster(closed, handles, rosterDigest(handles))
	}

	/**
	 * The roster of `closed` over `handles`, whose digest is `digest`: the one Roster.of takes, or the one a served file
	 * carries beside the roster's name, which generate took (served/json.ts), so a load hashes no handle.
	 */
	constructor(closed: DeclaredName, handles: NonEmptyReadonlyArray<string>, digest: RosterDigest) {
		this.closed = closed
		this.handles = Object.isFrozen(handles) ? handles : Object.freeze(handles)
		this.digest = digest
		Object.freeze(this)
	}

	[canonicalTag](): TaggedValue {
		return { tag: "roster", payload: `${this.closed}:${this.digest}` }
	}
}

/** The integer carriers, a serial field's among them. */
export type IntegerCarrier = "int2" | "int4" | "int8"
export type SpanCarrier = (typeof spanCarriers)[number]
/** The carriers whose descriptor holds nothing beside its carrier, its capabilities and its contract. */
type BareCarrier = "float4" | "float8" | "money" | "bool" | "uuid" | "date"

/** A date: a calendar day, as a span's endpoint, a closed id's payload or a field. */
export type DateType = BareType & { readonly carrier: "date" }

/** Whether a type is a date's, a date itself or a contract over one. */
export const isDateType = (t: ScalarType): t is DateType => t.carrier === "date"

/**
 * A bounded, half-open span over an endpoint of its carrier (range4 over int4, range8 over int8, rangeDate over date),
 * with an optional fixed positive width, of the endpoint's units: a count of days over date. Every value of a span type is nonempty and bounded, so lower() and upper()
 * never return NULL: a stored column carries the span shape CHECK (physical/span/storage.ts), a literal has
 * start < end (expr.ts literalProblem), a parameter or fact is admitted only as one (scalar/values/span.ts makeSpan),
 * a producer never delivers an empty piece, and no operation of the catalogue returns a span. The Allen reading of
 * endpoint predicates (check/allen.ts) rests on it.
 */
export interface SpanInfo {
	readonly endpoint: IntegerType<"int4"> | IntegerType<"int8"> | DateType
	readonly width: bigint | undefined
}

/**
 * The descriptor is a union tagged by carrier: each variant holds exactly the fields its carrier has, so a field is read
 * off a variant the carrier narrowed to, or through its total accessor (contractOf, textOf, rosterOf, spanOf,
 * numericTypmodOf, vectorTypmodOf). A contract mirrors its base's typmod, text refinement, roster and span (the decoder
 * checks the copies agree).
 */
interface IntegerType<C extends IntegerCarrier = IntegerCarrier> {
	readonly carrier: C
	readonly caps: CapabilitySet
	readonly contract: ContractInfo | undefined
}

/** numeric(p, s): what a field, a cast, a parameter and a typed literal declare, a contract's base among them. */
interface NumericTypmodType {
	readonly carrier: "numeric"
	readonly caps: CapabilitySet
	readonly typmod: NumericTypmod
	readonly contract: ContractInfo | undefined
}

/**
 * A computed numeric, PostgreSQL's numeric of no typmod: an aggregate's, an operation's or a conversion's result, with
 * the bound its making proved. No declaration names one, so it is never a declared type, a contract or a contract's
 * base.
 */
export interface NumericValueType {
	readonly carrier: "numeric"
	readonly caps: CapabilitySet
	readonly typmod: undefined
	readonly contract: undefined
	readonly bound: NumericBound
}

type NumericType = NumericTypmodType | NumericValueType

/**
 * The value domains a contract is over: every value type a field declares, never a computed numeric or an exact value,
 * which only an operation makes, nor a set over a roster, whose holes and padding no predicate over it could keep apart,
 * nor bytes, which no predicate reads.
 */
export type ContractBase = Exclude<ScalarType, NumericValueType | ExactType | BitsType | BytesType>

/**
 * What a field descriptor declares (scalar/registry.ts scalarTypeOf): a value domain a contract may be over, a set over
 * a roster, or bytes. A computed numeric and an exact value are a value's making, which no declaration states. How a
 * field is written, by its sequence among the ways, is the field's writing, never its type.
 */
export type DeclaredType = ContractBase | BitsType | BytesType

/** Whether a type is a computed numeric, which no declaration states. */
export const isNumericValue = (t: ScalarType): t is NumericValueType =>
	t.carrier === "numeric" && t.typmod === undefined

/** Whether a type is an exact arithmetic result, which no declaration states. */
export const isExactValue = (t: ScalarType): t is ExactType =>
	t.carrier === "exactInteger" || t.carrier === "exactMoney"

interface BareType {
	readonly carrier: BareCarrier
	readonly caps: CapabilitySet
	readonly contract: ContractInfo | undefined
}

export interface TextType {
	readonly carrier: "text"
	readonly caps: CapabilitySet
	readonly contract: ContractInfo | undefined
	readonly text: TextInfo
}

/**
 * A closed id: one of the roster's live handles, stored as its code, a smallint under the roster's domain. Its order is
 * code order, which is the roster's declared order.
 */
interface CodeType {
	readonly carrier: "code"
	readonly caps: CapabilitySet
	readonly contract: ContractInfo | undefined
	readonly roster: Roster
}

/**
 * A set over a roster's codes: bit(n), n every code the roster has minted, holes included, position i code i. No
 * contract is over one, and no field is a span or vector of one.
 */
interface BitsType {
	readonly carrier: "bits"
	readonly caps: CapabilitySet
	readonly roster: Roster
}

/**
 * bytea: a value written and read back whole, of the storage capability alone (scalar/registry.ts nativeCapabilities),
 * so no key, rule, computation, parameter or filter reads one, and no contract is over one.
 */
interface BytesType {
	readonly carrier: "bytes"
	readonly caps: CapabilitySet
}

interface SpanType {
	readonly carrier: SpanCarrier
	readonly caps: CapabilitySet
	readonly contract: ContractInfo | undefined
	readonly span: SpanInfo
}

interface VectorType {
	readonly carrier: "vector"
	readonly caps: CapabilitySet
	readonly typmod: VectorTypmod
	readonly contract: ContractInfo | undefined
}

/**
 * An exact arithmetic result: exactInteger, an integer, the value of add, sub, mul, neg, abs, gcd, lcm and integer
 * division over the integer carriers; exactMoney, an amount of money in cents, the value of add and sub over money and
 * of a money sum. Delivered as bigint and as Money, so no such operation overflows: `digits` bounds every value,
 * |x| < 10^digits (of the amount, for money), as its operands' bounds give it (scalar/compute/lower.ts), the way a
 * typmod bounds numeric(p, 0). In SQL an exact integer of at most 18 digits is bigint, and any other exact value
 * numeric (exactMoney at scale 2). Neither is a field's carrier, so neither has a contract or a serial form;
 * Compute.cast narrows one into a storage carrier where the value is proved to fit.
 */
interface ExactType {
	readonly carrier: ExactValueCarrier
	readonly caps: CapabilitySet
	readonly digits: number
}

/**
 * The scalar type IR.
 *
 * A ScalarType is the canonical native carrier identity of a value plus everything that changes its meaning:
 * numeric typmod or a computed numeric's bound, contract identity, text refinement, closed roster, span endpoint, vector
 * dimensions, an exact value's digit bound, and the operation capability set. Two descriptors are the
 * same type exactly when they agree in each of these, a contract by its identity (sameScalarType). Aliases normalize at
 * construction:
 * `pg.decimal` is `numeric`, `pg.bool` is `bool`, and so on, so no alias reaches the IR.
 *
 * There is no nullable type: every ScalarType denotes a non-null domain, and absence is zero rows.
 */
export type ScalarType =
	| IntegerType<"int2">
	| IntegerType<"int4">
	| IntegerType<"int8">
	| NumericType
	| BareType
	| TextType
	| BytesType
	| CodeType
	| BitsType
	| SpanType
	| VectorType
	| ExactType

/** The contract a descriptor carries. */
export const contractOf = (t: ScalarType): ContractInfo | undefined => {
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "code":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return t.contract
		case "bytes":
		case "bits":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The text refinement of a text descriptor. */
export const textOf = (t: ScalarType): TextInfo | undefined => {
	switch (t.carrier) {
		case "text":
			return t.text
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The roster of a closed id or of a set over a roster. */
export const rosterOf = (t: ScalarType): Roster | undefined => {
	switch (t.carrier) {
		case "code":
		case "bits":
			return t.roster
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The range carrier of a span descriptor. */
export const spanCarrierOf = (t: ScalarType): SpanCarrier | undefined =>
	t.carrier === "range4" || t.carrier === "range8" || t.carrier === "rangeDate"
		? t.carrier
		: undefined

/** Whether a carrier is a span's. */
export const isSpanCarrier = (carrier: Carrier): carrier is SpanCarrier =>
	carrier === "range4" || carrier === "range8" || carrier === "rangeDate"

/** The span of a range descriptor. */
export const spanOf = (t: ScalarType): SpanInfo | undefined => {
	switch (t.carrier) {
		case "range4":
		case "range8":
		case "rangeDate":
			return t.span
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The typmod of a numeric descriptor, numeric(p, s); undefined for a computed numeric and every other carrier. */
export const numericTypmodOf = (t: ScalarType): NumericTypmod | undefined => {
	switch (t.carrier) {
		case "numeric":
			return t.typmod
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The typmod of a vector descriptor, vector(n). */
export const vectorTypmodOf = (t: ScalarType): VectorTypmod | undefined => {
	switch (t.carrier) {
		case "vector":
			return t.typmod
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The digit bound of an exact descriptor; undefined for every other carrier. */
export const exactDigitsOf = (t: ScalarType): number | undefined =>
	t.carrier === "exactInteger" || t.carrier === "exactMoney" ? t.digits : undefined

/** The proved bound of a computed numeric; undefined for numeric(p, s) and every other carrier. */
export const numericBoundOf = (t: ScalarType): NumericBound | undefined =>
	t.carrier === "numeric" && t.typmod === undefined ? t.bound : undefined

const sameNumericBound = (a: NumericBound | undefined, b: NumericBound | undefined): boolean =>
	a?.digits === b?.digits && a?.scale === b?.scale

/** Two contracts are one by identity, their names and bases: two descriptors of one contract are one type whatever
 * predicate either carries. */
const sameContract = (a: ContractInfo | undefined, b: ContractInfo | undefined): boolean =>
	a === undefined || b === undefined ? a === b : a.name === b.name && sameScalarType(a.base, b.base)

const sameNumericTypmod = (a: NumericTypmod | undefined, b: NumericTypmod | undefined): boolean =>
	a?.precision === b?.precision && a?.scale === b?.scale

/** One list of patterns: each member's source and flags, in order. */
export const samePatterns = (a: Patterns, b: Patterns): boolean =>
	a === b ||
	(a.length === b.length &&
		a.every((p, i) => {
			const q = b[i]
			return q !== undefined && p.source === q.source && p.flags === q.flags
		}))

const sameRegexRef = (a: RegexRef | "wildcard", b: RegexRef | "wildcard"): boolean =>
	a === "wildcard" || b === "wildcard"
		? a === b
		: samePatterns(a.patterns, b.patterns) && a.key === b.key

const sameText = (a: TextInfo | undefined, b: TextInfo | undefined): boolean =>
	a === undefined || b === undefined
		? a === b
		: sameRegexRef(a.regex, b.regex) &&
			a.lengthBound === b.lengthBound &&
			a.byteBound === b.byteBound

/** One roster: its name and its handles in order, by their digest, as its canonical form states them. */
const sameRoster = (a: Roster | undefined, b: Roster | undefined): boolean =>
	a === undefined || b === undefined ? a === b : a.closed === b.closed && a.digest === b.digest

const sameSpan = (a: SpanInfo | undefined, b: SpanInfo | undefined): boolean =>
	a === undefined || b === undefined
		? a === b
		: a.width === b.width && sameScalarType(a.endpoint, b.endpoint)

/**
 * Type identity, field by field: one carrier and capability set, one contract by its identity (never
 * its predicate), and one numeric typmod or computed numeric bound, vector dimension count, text refinement (patterns,
 * language key and bounds), roster and span. Source locations never appear inside a descriptor.
 */
export const sameScalarType = (a: ScalarType, b: ScalarType): boolean =>
	a === b ||
	(a.carrier === b.carrier &&
		sameOrder(a.caps, b.caps) &&
		sameContract(contractOf(a), contractOf(b)) &&
		sameNumericTypmod(numericTypmodOf(a), numericTypmodOf(b)) &&
		sameNumericBound(numericBoundOf(a), numericBoundOf(b)) &&
		vectorTypmodOf(a)?.dims === vectorTypmodOf(b)?.dims &&
		exactDigitsOf(a) === exactDigitsOf(b) &&
		sameText(textOf(a), textOf(b)) &&
		sameRoster(rosterOf(a), rosterOf(b)) &&
		sameSpan(spanOf(a), spanOf(b)))

/** A contract contributes its base. */
export const baseOf = (t: ScalarType): ScalarType => {
	const contract = contractOf(t)
	return contract === undefined ? t : baseOf(contract.base)
}

/** The text of every value: the canonical wildcard, which proves no bound. */
const everyText: TextInfo = Object.freeze({
	regex: "wildcard",
	lengthBound: undefined,
	byteBound: undefined
})

/**
 * A type without the refinement its column's domain alone enforces, which the TypeScript type of its values leaves
 * unnamed: a text's pattern and byte bound, leaving the text of every value. Every other part of a type is its values'
 * own: a contract, natural among them, whose identity the field classes keep (analysis/theory/classes.ts), a numeric
 * typmod, which rounds, an integer width, a roster, a span's endpoint and width, and a vector's dimensions.
 *
 * A value enters a stored column of type `t` at `enteredType(t)`, whoever writes it, the caller, PostgreSQL's generation
 * or grizzle's fill, and the column's domain refuses one outside `t`, an outcome on that pattern's rule.
 */
export const enteredType = (t: ScalarType): ScalarType =>
	t.carrier === "text" && t.contract === undefined && t.text.regex !== "wildcard"
		? Object.freeze({ ...t, text: everyText })
		: t

/**
 * Whether two types differ only in what a column's domain enforces (enteredType): a value of either enters a stored
 * column of the other, its domain the judge.
 */
export const sameEnteredType = (a: ScalarType, b: ScalarType): boolean =>
	sameScalarType(enteredType(a), enteredType(b))

/**
 * Whether a value of this type is refined beyond its base: a contract, or text with a specific pattern. A comparison
 * parameter is never cast to such a type.
 */
export const isRefined = (t: ScalarType): boolean => {
	const text = textOf(t)
	return contractOf(t) !== undefined || (text !== undefined && text.regex !== "wildcard")
}

/** Each carrier's PostgreSQL type name, which typeLabel prints for a carrier of no parameters. */
export const nativeNames: Readonly<Record<Carrier, string>> = {
	int2: "smallint",
	int4: "integer",
	int8: "bigint",
	numeric: "numeric",
	float4: "real",
	float8: "double precision",
	money: "money",
	bool: "boolean",
	uuid: "uuid",
	date: "date",
	text: "text",
	bytes: "bytea",
	code: "smallint",
	bits: "bit",
	range4: "int4range",
	range8: "int8range",
	rangeDate: "daterange",
	vector: "vector",
	exactInteger: "numeric",
	exactMoney: "numeric"
}

/**
 * A text refinement as diagnostics name it: its patterns, and the byte bound str.bytes cuts it to, as
 * "text ~ /^[a-z]+$/u", "text ~ /^[a-z]+$/u & /^.{0,8}$/su" or "text ~ /^.*$/su of at most 64 bytes".
 */
export const refinementText = (regex: RegexRef): string => {
	const octets = octetsOf(regex.check)
	return `text ~ ${patternsText(regex.patterns)}${octets === undefined ? "" : ` of at most ${octets} bytes`}`
}

/**
 * A short human label for printing and diagnostics, never emitted SQL (the physical package owns domain identifiers):
 * "numeric(10,2)", "contract Cents over bigint", "code Kind", "bits Kind", "text ~ /^[a-z]+$/u".
 */
export const typeLabel = (t: ScalarType): string => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		return `contract ${contract.name} over ${typeLabel(contract.base)}`
	}
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return nativeNames[t.carrier]
		case "numeric":
			return t.typmod === undefined
				? `numeric of ${t.bound.digits} integer and ${t.bound.scale} fraction digits`
				: `numeric(${t.typmod.precision},${t.typmod.scale})`
		case "vector":
			return `vector(${t.typmod.dims})`
		case "code":
			return `code ${t.roster.closed}`
		case "bits":
			return `bits ${t.roster.closed}`
		case "text": {
			const { regex } = t.text
			return regex === "wildcard" ? "text" : refinementText(regex)
		}
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "bytes":
		case "range4":
		case "range8":
		case "rangeDate":
			return nativeNames[t.carrier]
		case "exactInteger":
			return `exact integer of ${t.digits} digits`
		case "exactMoney":
			return `exact money of ${t.digits} digits`
	}
}
