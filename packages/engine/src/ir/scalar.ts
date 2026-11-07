import { sameOrder } from "#compiler/core/array.ts"
import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	canonicalTag,
	everyProperty,
	type TaggedValue
} from "#compiler/core/canonical.ts"
import { ownedDigest } from "#compiler/core/fingerprint.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import { derived, type Limit, postgresSource, published } from "#compiler/core/limits.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import type { Fact } from "#compiler/ir/proof.ts"

/**
 * The native carriers grizzle admits. range4 and range8 are int4range and int8range,
 * the only span carriers; date is a calendar day; there is no timestamp, interval, bytea, JSON or array carrier. exactInteger and
 * exactMoney are the exact arithmetic carriers (ExactType), never a field's.
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
	"code",
	"bits",
	"range4",
	"range8",
	"vector",
	"exactInteger",
	"exactMoney"
] as const
export type Carrier = (typeof carriers)[number]

/** The exact arithmetic carriers: what integer and money arithmetic computes (ExactType). */
export type ExactValueCarrier = "exactInteger" | "exactMoney"

/** The carriers a field, a parameter or a literal of a descriptor can have: every carrier but the exact ones. */
export type StorageCarrier = Exclude<Carrier, ExactValueCarrier>

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
	code: true,
	bits: false,
	range4: false,
	range8: false,
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

/** The span carriers, range4 over int4 endpoints and range8 over int8 endpoints. */
export const spanCarriers = ["range4", "range8"] as const satisfies ReadonlyArray<Carrier>

/**
 * The operation capability vocabulary: storage, equality, ordering, hashing used for bucketing, the
 * aggregate overload families, span endpoints, expression-index eligibility, GiST, the set algebra of a set over a
 * roster (union, intersection, difference, cardinality, subset and disjointness), and the admitted extension
 * operation. A CapabilitySet is sorted and duplicate-free, so its canonical form is its identity.
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

const numericH = `${postgresSource}/src/include/utils/numeric.h`

/** The greatest precision a numeric typmod declares. */
export const numericMaxPrecision: Limit = published({
	value: 1000,
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope:
		"the precision p of numeric(p, s): a field's, a cast's, a parameter's or a typed literal's",
	constraint: "compile-time constant",
	source: `${numericH}#L35`,
	quote: "#define NUMERIC_MAX_PRECISION\t\t1000",
	verified: "2026-11-05"
})

/** The least scale a numeric typmod declares: a negative scale rounds to a power of ten. */
export const numericMinScale: Limit = published({
	value: -1000,
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope: "the scale s of numeric(p, s)",
	constraint: "compile-time constant",
	source: `${numericH}#L37`,
	quote: "#define NUMERIC_MIN_SCALE\t\t\t(-1000)",
	verified: "2026-11-05"
})

/** The greatest scale a numeric typmod declares. */
export const numericMaxScale: Limit = published({
	value: 1000,
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope: "the scale s of numeric(p, s)",
	constraint: "compile-time constant",
	source: `${numericH}#L38`,
	quote: "#define NUMERIC_MAX_SCALE\t\t\t1000",
	verified: "2026-11-05"
})

const datatypeSgml = `${postgresSource}/doc/src/sgml/datatype.sgml`

/**
 * The most integer digits a numeric value has, |x| < 10^numericMaxIntegerDigits: past it PostgreSQL's arithmetic raises
 * 22003 "value overflows numeric format", so a numeric expression whose bound passes it is ResourceBound.
 */
export const numericMaxIntegerDigits: Limit = published({
	value: 131072,
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope: "the integer digits of every numeric value, a computed one's bound included",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L399`,
	quote: "up to 131072 digits before the decimal point; up to 16383 digits after the decimal point",
	verified: "2026-11-05"
})

/**
 * The most fraction digits a numeric value has: NUMERIC_DSCALE_MAX, past which numeric multiplication rounds
 * (numeric.c mul_var's caller) and a value's text is refused.
 */
export const numericMaxFractionDigits: Limit = published({
	value: 16383,
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope: "the fraction digits of every numeric value, a computed one's bound included",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L399`,
	quote: "up to 131072 digits before the decimal point; up to 16383 digits after the decimal point",
	verified: "2026-11-05"
})

/**
 * The most fraction digits PostgreSQL gives a division's, a mean's, a square root's or a power's result,
 * NUMERIC_MAX_DISPLAY_SCALE: select_div_scale and its kin take a result scale no larger.
 */
export const numericMaxDisplayScale: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope: "the result scale of numeric division, avg, sqrt and power",
	from: [numericMaxPrecision],
	derivation: `numeric.h defines it as the greatest precision: "#define NUMERIC_MAX_DISPLAY_SCALE\tNUMERIC_MAX_PRECISION" (${numericH}#L43)`,
	compute: ([p]) => p.value
})

/**
 * The significant digits PostgreSQL gives an inexact numeric result at least, NUMERIC_MIN_SIG_DIGITS: a division's,
 * a square root's and a power's result scale is chosen to give that many.
 */
export const numericMinSigDigits: Limit = published({
	value: 16,
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope: "the significant digits select_div_scale and its kin choose a result scale for",
	constraint: "compile-time constant",
	source: `${numericH}#L53`,
	quote: "#define NUMERIC_MIN_SIG_DIGITS\t\t16",
	verified: "2026-11-05"
})

/** The internal limit on a calculation's result scale, NUMERIC_MAX_RESULT_SCALE. */
export const numericMaxResultScale: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope: "the scale of an intermediate numeric result, which exp_var's input bound is three times",
	from: [numericMaxPrecision],
	derivation: `numeric.h: "#define NUMERIC_MAX_RESULT_SCALE\t(NUMERIC_MAX_PRECISION * 2)" (${numericH}#L46)`,
	compute: ([p]) => p.value * 2
})

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

/** Proved bounds on every member of a language, in code points and UTF-8 bytes. */
export interface TextBounds {
	readonly length: number
	readonly bytes: number
}

/**
 * How PostgreSQL enforces a pattern's language some admitted text value is no member of, with the bounds the
 * enforcement proves on every member: `VALUE IN (...)` of its members, at least one since an analyzed language has a
 * member, or `VALUE ~ '<ARE>'` of the pattern's translation. The text analysis chooses it (text/refinement.ts).
 */
export type PatternCheck =
	| {
			readonly kind: "finite"
			readonly members: NonEmptyReadonlyArray<string>
			readonly bounds: TextBounds
	  }
	| { readonly kind: "regex"; readonly pattern: string; readonly bounds: TextBounds | undefined }

/**
 * How PostgreSQL enforces a text refinement: its pattern's language (PatternCheck), or a byte bound that cuts it,
 * `octet_length(VALUE) <= octets` beside the pattern's check, or alone where the pattern admits every value
 * (str.bytes), with the tighter of the pattern's bounds and the byte bound's, a code point taking at least a byte.
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

/**
 * A regex refinement: its source and flags as declared, its language's key and its enforcement, which the text
 * analysis computes where it builds the reference. The text package owns the pattern IR; the scalar type carries what
 * every later pass reads of it, so none analyzes the pattern again.
 */
export interface RegexRef {
	readonly source: string
	readonly flags: "u" | "su"
	readonly key: RegexKey
	readonly check: RegexCheck
}

/**
 * What the text analysis proved of a text descriptor's pattern, which the descriptor carries from where it is admitted
 * (text/refinement.ts textLanguage): every admitted value, a tautology, or a language some admitted value is no member
 * of, by its key and its enforcement. It is a function of the pattern beside it, so it is no part of the descriptor's
 * semantic identity (core/canonical.ts omitSourceLocs).
 */
export type TextLanguage =
	| { readonly kind: "every" }
	| { readonly kind: "refined"; readonly key: RegexKey; readonly check: RegexCheck }

/** The text metadata a ScalarType carries for a pattern of `language`: its regex reference and its proved bounds. */
export const textInfoOf = (source: string, flags: "u" | "su", language: TextLanguage): TextInfo => {
	if (language.kind === "every") {
		return Object.freeze({ regex: "wildcard", lengthBound: undefined, byteBound: undefined })
	}
	const regex = Object.freeze({ source, flags, key: language.key, check: language.check })
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
export const wildcardSource = "^.*$"
export const wildcardFlags: "u" | "su" = "su"

/**
 * A pattern's own language, before a byte bound cuts it: every text, or the language its pattern's check enforces,
 * by its key. The text analysis proves one of a pattern (text/refinement.ts textLookup).
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
		? { length: octets, bytes: octets }
		: { length: Math.min(bounds.length, octets), bytes: Math.min(bounds.bytes, octets) }

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
			check: { kind: "octets", octets, check: undefined, bounds: boundsWithin(undefined, octets) }
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
		check: { kind: "octets", octets, check, bounds: boundsWithin(check.bounds, octets) }
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
 * Its canonical form is its name alone (core/canonical.ts Canonicalizable): one schema holds one roster of a name, whose
 * handles its closed relation's description encodes once, so a type, a literal or a predicate over the roster names it
 * by identity, its encoding the same size whatever the roster's.
 */
export class Roster implements Canonicalizable {
	readonly closed: DeclaredName
	readonly handles: NonEmptyReadonlyArray<string>

	constructor(closed: DeclaredName, handles: NonEmptyReadonlyArray<string>) {
		this.closed = closed
		this.handles = Object.isFrozen(handles) ? handles : Object.freeze(handles)
		Object.freeze(this)
	}

	[canonicalTag](): TaggedValue {
		return { tag: "roster", payload: this.closed }
	}
}

/** The integer carriers, a serial field's among them. */
export type IntegerCarrier = "int2" | "int4" | "int8"
export type SpanCarrier = (typeof spanCarriers)[number]
/** The carriers whose descriptor holds nothing beside its carrier, its capabilities and its contract. */
type BareCarrier = "float4" | "float8" | "money" | "bool" | "uuid" | "date"

/**
 * A bounded, half-open span over an integer endpoint of its carrier's width (range4 over int4, range8 over int8),
 * with an optional fixed positive width. Every value of a span type is nonempty and bounded, so lower() and upper()
 * never return NULL: a stored column carries the span shape CHECK (physical/span/storage.ts), a literal has
 * start < end (expr.ts literalProblem), a parameter or fact is admitted only as one (scalar/values/span.ts makeSpan),
 * a producer never delivers an empty piece, and no operation of the catalogue returns a span. The Allen reading of
 * endpoint predicates (check/allen.ts) rests on it.
 */
export interface SpanInfo {
	readonly endpoint: IntegerType<"int4"> | IntegerType<"int8">
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
 * which only an operation makes, nor a set over a roster, whose holes and padding no predicate over it could keep apart.
 */
export type ContractBase = Exclude<ScalarType, NumericValueType | ExactType | BitsType>

/**
 * What a field descriptor declares (scalar/registry.ts scalarTypeOf): a value domain a contract may be over, or a set
 * over a roster. A computed numeric and an exact value are a value's making, which no declaration states. How a field
 * is written, by its sequence among the ways, is the field's writing, never its type.
 */
export type DeclaredType = ContractBase | BitsType

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
		case "vector":
			return t.contract
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
		case "code":
		case "bits":
		case "range4":
		case "range8":
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
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The range carrier of a span descriptor. */
export const spanCarrierOf = (t: ScalarType): SpanCarrier | undefined =>
	t.carrier === "range4" || t.carrier === "range8" ? t.carrier : undefined

/** The span of a range descriptor. */
export const spanOf = (t: ScalarType): SpanInfo | undefined => {
	switch (t.carrier) {
		case "range4":
		case "range8":
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
		case "code":
		case "bits":
		case "range4":
		case "range8":
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
		case "code":
		case "bits":
		case "range4":
		case "range8":
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

const sameRegexRef = (a: RegexRef | "wildcard", b: RegexRef | "wildcard"): boolean =>
	a === "wildcard" || b === "wildcard"
		? a === b
		: a.source === b.source && a.flags === b.flags && a.key === b.key

const sameText = (a: TextInfo | undefined, b: TextInfo | undefined): boolean =>
	a === undefined || b === undefined
		? a === b
		: sameRegexRef(a.regex, b.regex) &&
			a.lengthBound === b.lengthBound &&
			a.byteBound === b.byteBound

const sameRoster = (a: Roster | undefined, b: Roster | undefined): boolean =>
	a === undefined || b === undefined
		? a === b
		: a.closed === b.closed && sameOrder(a.handles, b.handles)

const sameSpan = (a: SpanInfo | undefined, b: SpanInfo | undefined): boolean =>
	a === undefined || b === undefined
		? a === b
		: a.width === b.width && sameScalarType(a.endpoint, b.endpoint)

/**
 * Type identity, field by field: one carrier and capability set, one contract by its identity (never
 * its predicate), and one numeric typmod or computed numeric bound, vector dimension count, text refinement (pattern,
 * flags, language key and bounds), roster and span. Source locations never appear inside a descriptor.
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

/**
 * Whether a value of this type is refined beyond its base: a contract, or text with a specific pattern. A comparison
 * parameter is never cast to such a type.
 */
export const isRefined = (t: ScalarType): boolean => {
	const text = textOf(t)
	return contractOf(t) !== undefined || (text !== undefined && text.regex !== "wildcard")
}

const nativeNames: Readonly<Record<Carrier, string>> = {
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
	code: "smallint",
	bits: "bit",
	range4: "int4range",
	range8: "int8range",
	vector: "vector",
	exactInteger: "numeric",
	exactMoney: "numeric"
}

/**
 * A text refinement as diagnostics name it: its pattern, and the byte bound str.bytes cuts it to, as
 * "text ~ /^[a-z]+$/u" or "text ~ /^.*$/su of at most 64 bytes".
 */
export const refinementText = (regex: RegexRef): string => {
	const octets = octetsOf(regex.check)
	return `text ~ /${regex.source}/${regex.flags}${octets === undefined ? "" : ` of at most ${octets} bytes`}`
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
		case "range4":
		case "range8":
			return nativeNames[t.carrier]
		case "exactInteger":
			return `exact integer of ${t.digits} digits`
		case "exactMoney":
			return `exact money of ${t.digits} digits`
	}
}

export const nativeName = (carrier: Carrier): string => nativeNames[carrier]
