import { sameOrder } from "#compiler/core/array.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import type { Fact } from "#compiler/ir/proof.ts"

/**
 * The native carriers grizzle admits. range4 and range8 are int4range and int8range,
 * the only span carriers; there is no timestamp, date, interval, bytea, JSON or array carrier. exactInteger and
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
	"text",
	"enum",
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
 * Whether a column of each carrier holds few values, so that fixing it bounds no scan: a closed handle holds one of a
 * roster's handles, a boolean one of two. An index led by such a column narrows a lookup little, and a lookup that fixes
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
	text: false,
	enum: true,
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

export const spanCarriers: ReadonlyArray<Carrier> = ["range4", "range8"]

/**
 * The operation capability vocabulary: storage, equality, ordering, hashing used for bucketing, the
 * aggregate overload families, span endpoints, expression-index eligibility, GiST, and the admitted extension
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
 * numeric(p, s): precision 1..1000, scale -1000..1000. numeric(p) is numeric(p, 0), so the scale is always present:
 * one typmod, one identity.
 */
export interface NumericTypmod {
	readonly precision: number
	readonly scale: number
}

/** vector(n): 1..16000 dimensions. */
export interface VectorTypmod {
	readonly dims: number
}

/**
 * A nominal contract: a domain over its base with an optional predicate and the facts it proves. Compatibility is by
 * contract identity (name and base), never by predicate equality: sameScalarType ignores the predicate and the facts. The predicate
 * is the domain's one constraint, <contract>__check, an ExprTable in normal form (expr.ts predicateTable), so its
 * canonical text, which fingerprints include, does not depend on allocation order. The base is a value domain of the contract's own carrier, never a serial declaration.
 * The name is a declared name, parsed where the contract is built (scalar/registry.ts contractOver) and where a
 * descriptor is decoded (scalar-shape.ts), so the naming door mints the contract's domain from it directly
 * (core/identity.ts identity.contractDomain).
 */
export interface ContractInfo {
	readonly name: DeclaredName
	readonly base: ValueType
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
 * A regex refinement: its source and flags as declared, and its language's key, which the text analysis computes where
 * it builds the reference. The text package owns the pattern IR; the scalar type needs only the pattern to analyze
 * again and the key to compare by.
 */
export interface RegexRef {
	readonly source: string
	readonly flags: "u" | "su"
	readonly key: RegexKey
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
 * A closed roster: the closed relation's declared name and its distinct handles in declared order, which is comparison
 * order. The name is the roster's whole link to its enum: the naming door mints the enum type from it
 * (core/identity.ts identity.enumType), as ownership mints the closed relation's.
 */
export interface Roster {
	readonly closed: DeclaredName
	readonly handles: NonEmptyReadonlyArray<string>
}

/** The integer carriers, the serial generation's carriers. */
export type IntegerCarrier = "int2" | "int4" | "int8"
export type SpanCarrier = "range4" | "range8"
/** The carriers whose descriptor holds nothing beside its carrier, its capabilities and its contract. */
type BareCarrier = "float4" | "float8" | "money" | "bool" | "uuid"

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
 * numericTypmodOf, vectorTypmodOf). A serial declaration shares the integer carriers and is told apart by its `serial`
 * field ("serial" in t). A contract mirrors its base's typmod, text refinement, roster and span (the decoder checks the
 * copies agree).
 */
interface IntegerType<C extends IntegerCarrier = IntegerCarrier> {
	readonly carrier: C
	readonly caps: CapabilitySet
	readonly contract: ContractInfo | undefined
}

/**
 * A column generated ALWAYS AS IDENTITY: a generation declaration over an integer carrier, not a value domain, so it
 * is never a contract, a contract's base or a span endpoint.
 */
interface SerialType {
	readonly carrier: IntegerCarrier
	readonly caps: CapabilitySet
	readonly serial: "always"
}

interface NumericType {
	readonly carrier: "numeric"
	readonly caps: CapabilitySet
	readonly typmod: NumericTypmod | undefined
	readonly contract: ContractInfo | undefined
}

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

interface EnumType {
	readonly carrier: "enum"
	readonly caps: CapabilitySet
	readonly contract: ContractInfo | undefined
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

/** A value domain: every descriptor but a serial declaration. */
export type ValueType =
	| IntegerType<"int2">
	| IntegerType<"int4">
	| IntegerType<"int8">
	| NumericType
	| BareType
	| TextType
	| EnumType
	| SpanType
	| VectorType
	| ExactType

/**
 * The scalar type IR.
 *
 * A ScalarType is the canonical native carrier identity of a value plus everything that changes its meaning:
 * numeric typmod, contract identity, text refinement, closed roster, span endpoint, vector dimensions, an exact
 * value's digit bound, serial generation, and the operation capability set. Two descriptors are the same type exactly when they agree in each of
 * these, a contract by its identity (sameScalarType). Aliases normalize at construction:
 * `pg.decimal` is `numeric`, `pg.bool` is `bool`, and so on, so no alias reaches the IR.
 *
 * There is no nullable type: every ScalarType denotes a non-null domain, and absence is zero rows.
 */
export type ScalarType = ValueType | SerialType

/** The contract a descriptor carries; a serial declaration is never one. */
export const contractOf = (t: ScalarType): ContractInfo | undefined => {
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return "serial" in t ? undefined : t.contract
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "text":
		case "enum":
		case "range4":
		case "range8":
		case "vector":
			return t.contract
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
		case "enum":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The closed roster of an enum descriptor. */
export const rosterOf = (t: ScalarType): Roster | undefined => {
	switch (t.carrier) {
		case "enum":
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
		case "text":
		case "enum":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** The typmod of a numeric descriptor, numeric(p, s); undefined for unconstrained numeric and every other carrier. */
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
		case "text":
		case "enum":
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
		case "text":
		case "enum":
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
 * Type identity, field by field: one carrier, capability set and serial generation, one contract by its identity (never
 * its predicate), and one numeric typmod, vector dimension count, text refinement (pattern, flags, language key and
 * bounds), roster and span. Source locations never appear inside a descriptor.
 */
export const sameScalarType = (a: ScalarType, b: ScalarType): boolean =>
	a === b ||
	(a.carrier === b.carrier &&
		sameOrder(a.caps, b.caps) &&
		"serial" in a === "serial" in b &&
		sameContract(contractOf(a), contractOf(b)) &&
		sameNumericTypmod(numericTypmodOf(a), numericTypmodOf(b)) &&
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
	text: "text",
	enum: "enum",
	range4: "int4range",
	range8: "int8range",
	vector: "vector",
	exactInteger: "numeric",
	exactMoney: "numeric"
}

/**
 * A short human label for printing and diagnostics, never emitted SQL (the physical package owns domain and enum
 * identifiers): "numeric(10,2)", "contract Cents over bigint", "enum Kind", "text ~ /^[a-z]+$/u".
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
			return "serial" in t ? `${nativeNames[t.carrier]} serial` : nativeNames[t.carrier]
		case "numeric":
			return t.typmod === undefined ? "numeric" : `numeric(${t.typmod.precision},${t.typmod.scale})`
		case "vector":
			return `vector(${t.typmod.dims})`
		case "enum":
			return `enum ${t.roster.closed}`
		case "text": {
			const { regex } = t.text
			return regex === "wildcard" ? "text" : `text ~ /${regex.source}/${regex.flags}`
		}
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
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
