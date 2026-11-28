import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { Columned } from "#compiler/core/decoder.ts"
import {
	type CompileError,
	malformedDescription,
	ruleRefused,
	unsupported
} from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import {
	admitDeclaredName,
	type DeclaredName,
	parseDeclaredName,
	parseDerivedName,
	type HeldName
} from "#compiler/core/identity.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	type Built,
	built,
	builtMark,
	type FieldMarked,
	fieldMark
} from "#compiler/core/phantom.ts"
import { deepFreeze, hasProperties } from "#compiler/core/record.ts"
import type {
	ContractFieldDesc,
	ExprDesc,
	FieldDesc,
	PgScalarName,
	VariantFieldDesc
} from "#compiler/ir/desc.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import {
	baseOf,
	type Capability,
	type CapabilitySet,
	capabilitySet,
	capsOf,
	type Carrier,
	type ContractBase,
	type ContractInfo,
	type DeclaredType,
	type ExactValueCarrier,
	isDateType,
	isExactValue,
	inRosterOrder,
	isRosterSubset,
	languageOctets,
	languageWithin,
	type BareCarrier,
	type IntegerCarrier,
	type NumericBound,
	type NumericTypmod,
	type NumericValueType,
	type PatternLanguage,
	patternsText,
	type Roster,
	type ScalarType,
	type SpanCarrier,
	textInfoOf,
	typeLabel,
	type VariantArm,
	type ArmField,
	type VariantInfo,
	variantOnly,
	type VariantType
} from "#compiler/ir/scalar.ts"
import type { TextSearchConfiguration } from "#compiler/ir/search.ts"
import { minted, mintedRefusal } from "#compiler/scalar/minted.ts"
import { nativeCapabilities, unorderedCodeCapabilities } from "#compiler/scalar/native.ts"
import { numericMaxIntegerDigits, numericOwnBound } from "#compiler/scalar/values/fault.ts"

/** The capability set of a carrier. */
export const capabilitiesOf = (carrier: Carrier): CapabilitySet =>
	capabilitySet(nativeCapabilities[carrier])

export const hasCapability = (t: ScalarType, capability: Capability): boolean =>
	capsOf(t).includes(capability)

/** The carriers whose values break a completed order's ties though no stated order reads them (breaksTies). */
const tieBreakingCarriers: ReadonlySet<Carrier> = new Set<Carrier>([
	"code",
	"bits",
	"bytes",
	"tsvector",
	"variant"
])

/**
 * Whether a type has a total order that an order grizzle completes may break ties by (logical/order.ts completeOrder):
 * an admitted order (the ordering capability), a closed id's codes, a set's bits, one bit per code of its roster, bytes
 * or a search document. A closed id's codes are history and never move, and so are a set's bits, so an unordered
 * roster's closed id, or a set, which no stated order reads, still breaks a tie the caller left open, the same way on
 * every run. Bytes and a search document hold no key and no parameter carries one (storedOnly, searchedOnly), so only
 * a keyless heading's completion appends one, after every field that tells its rows apart, and PostgreSQL's B-tree
 * order breaks the tie there (byteacmp, tsvector_cmp): the host never compares one (adapter/reader/run.ts groupOrder
 * reads a group's order no further than two rows differ, and a page refuses to seek by one).
 */
export const breaksTies = (t: ScalarType): boolean =>
	hasCapability(t, "ordering") || tieBreakingCarriers.has(baseOf(t).carrier)

/**
 * Whether a type is stored only: its capability set is storage alone, so a value of it is written and read back whole
 * and nothing more. No operation reads one, no parameter carries one, and neither PostgreSQL nor grizzle writes a field
 * of one; bytes is such a carrier (nativeCapabilities). Each of those refusals reads it here, off the capability set,
 * never off the carrier's name.
 */
export const storedOnly = (t: ScalarType): boolean => capsOf(t).every((c) => c === "storage")

/**
 * Whether a type is a search document's (ir/scalar.ts SearchType), the one type of the textSearch capability: a value
 * PostgreSQL alone makes, parsing texts, and reads, matching and ranking it, which a generated field parses from its
 * row's texts or a caller's field holds as a read delivered it (tsvector). So no parameter carries one, grizzle fills
 * none, and no literal is of one. Each of those refusals reads it here, off the capability set.
 */
export const searchedOnly = (t: ScalarType): boolean => capsOf(t).includes("textSearch")

/**
 * A capability diagnostic: UnsupportedOperation, its capability naming the
 * registry capability first, then what lacks it and why.
 */
const capabilityError = (loc: SourceLoc, capability: Capability, detail: string): CompileError =>
	unsupported(loc, `${capability}: ${detail}`)

/** Why a type is not a span endpoint: integer, bigint and contracts over them only. */
const spanEndpointDetail = (t: ScalarType): string => {
	const base = baseOf(t)
	if (base.carrier === "money") {
		return "is money, for which no range is admitted"
	}
	return "is not an admitted range endpoint; ranges are over int4, int8, date and domains over them"
}

/** The PostgreSQL type names of descriptors, the `sql` member of each. */
export const carrierSql = {
	int2: "int2",
	int4: "int4",
	int8: "int8",
	numeric: "numeric",
	float4: "float4",
	float8: "float8",
	money: "money",
	bool: "bool",
	uuid: "uuid",
	date: "date",
	inet: "inet",
	cidr: "cidr",
	text: "text",
	bytes: "bytea",
	sha256: "sha256",
	code: "code",
	bits: "bit",
	range4: "range",
	range8: "range",
	rangeDate: "range",
	vector: "vector",
	tsvector: "tsvector",
	exactInteger: "exact integer",
	exactMoney: "exact money",
	variant: "variant"
} as const satisfies { readonly [C in Carrier]: string }

/** A descriptor's SQL type name, the `sql` member of every descriptor and term: one of carrierSql's. */
export type SqlTag = (typeof carrierSql)[Carrier]

/**
 * What a runtime descriptor carries for the compiler: its SQL name and column, public, and its Description and
 * declared type (scalarTypeOf), internal.
 */
export interface Described<out Sql extends SqlTag = SqlTag> extends Columned<unknown> {
	readonly sql: Sql
	readonly desc: FieldDesc
	readonly scalar: DeclaredType
}

/** The members every descriptor is defined with: its column, whose values are its host type. */
type DescriptorMembers = Readonly<Record<string, unknown>> & Columned<unknown>

/**
 * The capability registry and the runtime descriptor protocol.
 *
 * Every field descriptor (pg.*, uuid, contract, span, closedId, vector and str.regex) is an
 * owned, frozen value that carries, beside its public members (its SQL name and its column, core/decoder.ts, whose
 * values are its host type), two internal ones:
 *
 * - `desc`, its FieldDesc: the descriptor as it crosses the Description boundary (ir/desc.ts);
 * - `scalar`, its ScalarType: the IR identity with its operation capability set (ir/scalar.ts).
 *
 * `describeField` reads them from any descriptor a caller hands in, and admits a descriptor only by identity: one this
 * package defined, or a str.regex descriptor its builder registered, which is read from its pattern. Anything else, a
 * JavaScript caller's look-alike or a copy of a descriptor, is CompileError MalformedDescription: a value no builder
 * made has no column a builder made, so nothing could deliver its values. A spelling of the serial family, serial
 * and its kin, is Refused by the model's own message: grizzle mints no ids (scalar/minted.ts).
 *
 * The capability registry states, per native carrier, which operations grizzle admits on it: storage, equality,
 * ordering, hashing, the aggregate families, span endpoints, expression-index and GiST eligibility, and the vector
 * distance. Every native claim is one PostgreSQL 19's catalog makes: an
 * equality operator and default B-tree, hash and GiST operator classes (GiST over btree_gist for scalars, range_ops
 * for spans), and the sum, avg, min, max, bool_and and bool_or aggregates. The registry admits less than the catalog
 * offers where the language does: pgvector's sum(vector) and avg(vector) are no aggregates of the language
 * (aggregate.ts), and the only span endpoints are integer and bigint.
 *
 * A contract keeps its base's capabilities: a domain has its base's operators, and arithmetic on it yields the base.
 * Every vector has vectorDistance: its
 * operands share one dimension count, which the type tags.
 *
 * A runtime descriptor: what it carries for the compiler, and the brand every builder-made value holds
 * (core/phantom.ts), so it has the public Field type its constructor's signature gives it.
 */
export interface Descriptor<out Sql extends SqlTag = SqlTag>
	extends Described<Sql>, Built, FieldMarked {}

/** Descriptors this package defined. A WeakSet holds no descriptor alive and is never enumerated, so it is no cache. */
const owned = new WeakSet<object>()

/**
 * Freezes `target` with its members, registers it as an owned descriptor, and returns it. `target` is an object or,
 * for a value-and-callable descriptor (numeric, whose call is numeric(p, s)), a function. Every member is non-writable;
 * the public ones, the column among them, are enumerable, and the internal desc and scalar are not enumerated. A caller
 * leaves an absent optional member out of `members`. Only defineField reaches it, so every owned descriptor was
 * decoded and checked.
 *
 * Object.assign gives the result its type, the target with the members and the internal forms; the properties are
 * then fixed to their final attributes. Each member is first defined writable, because a function's own `name` is
 * read-only and assigning it would throw; the keys are created in the order members, sql, desc, scalar, and freezing
 * leaves every property exactly as the definitions below make it.
 */
const defineDescriptor = <T extends object, M extends DescriptorMembers, Sql extends SqlTag>(
	target: T,
	described: Omit<Described<Sql>, "column">,
	members: M
): T & M & Descriptor<Sql> => {
	for (const [key, value] of Object.entries(members)) {
		Object.defineProperty(target, key, {
			value,
			enumerable: true,
			writable: true,
			configurable: true
		})
	}
	const descriptor = Object.assign(target, members, {
		...builtMark,
		...fieldMark,
		sql: described.sql,
		desc: described.desc,
		scalar: described.scalar
	})
	for (const [key, value] of Object.entries(members)) {
		Object.defineProperty(descriptor, key, {
			value,
			enumerable: true,
			writable: false,
			configurable: false
		})
	}
	Object.defineProperty(descriptor, "sql", {
		value: described.sql,
		enumerable: true,
		writable: false,
		configurable: false
	})
	Object.defineProperty(descriptor, "desc", {
		value: described.desc,
		enumerable: false,
		writable: false,
		configurable: false
	})
	Object.defineProperty(descriptor, "scalar", {
		value: described.scalar,
		enumerable: false,
		writable: false,
		configurable: false
	})
	Object.freeze(descriptor)
	owned.add(descriptor)
	return descriptor
}

/**
 * Defines a descriptor from its Description, which its builder made from the parts it checked as it took them (a
 * numeric's typmod, a vector's dimensions, a contract's name, base, predicate and facts, a span's endpoint and width, a
 * roster's name), frozen: the ScalarType is the registry's reading of `desc` (scalarTypeOf), so a descriptor's two
 * internal forms cannot disagree. Its column is one of its members, which its builder made from its
 * carrier's conversion (values/convert.ts), so the descriptor's host type is the column's. A refusal throws: builders
 * are pure and synchronous, and a malformed constructor argument from a JavaScript caller is a synchronous
 * CompileError.
 */
export const defineField = <
	T extends object,
	Sql extends SqlTag,
	const M extends DescriptorMembers
>(
	target: T,
	sql: Sql,
	desc: FieldDesc,
	members: M,
	loc: SourceLoc,
	env: ScalarEnv
): T & M & Descriptor<Sql> => {
	const frozen = deepFreeze(desc)
	const scalar = scalarTypeOf(frozen, env, loc)
	if (!scalar.ok) {
		throw scalar.error
	}
	return defineDescriptor(target, { sql, desc: frozen, scalar: scalar.value }, members)
}

export const isOwnedDescriptor = (value: unknown): value is Described =>
	(typeof value === "object" || typeof value === "function") && value !== null && owned.has(value)

/** What a text descriptor is read from: its patterns and its column. */
interface TextDescriptor extends Built, Columned<unknown> {
	readonly patterns: Patterns
}

/**
 * A text descriptor as its builder registered it: its patterns; their language as the text analysis proved it when the
 * descriptor was made, before any byte bound cuts it, which a str.bytes over the descriptor cuts and never analyzes
 * again; and what describeField answers for it.
 */
interface RegisteredText {
	readonly patterns: Patterns
	readonly language: Result.Result<PatternLanguage, CompileError>
	readonly described: Result.Result<Described, CompileError>
}

/**
 * The str.regex, str.and and str.bytes descriptors text/field.ts made, each with its patterns and what describeField
 * answers for it: its Description, which carries its patterns' language as the text analysis proved it once, when its
 * builder registered it, cut to its byte bound, its ScalarType and its column, or the refusal of its patterns. A
 * WeakMap holds nothing alive and is never enumerated.
 */
const ownedText = new WeakMap<object, RegisteredText>()

/**
 * Registers `value`, a frozen str.regex, str.and or str.bytes descriptor its builder made, with `language`, its
 * patterns' language as the text analysis proved it (text/refinement.ts textLookup), cut to `octets` UTF-8 bytes
 * (ir/scalar.ts languageWithin) where the descriptor has a byte bound, and returns it. The analysis is the
 * descriptor's admission: its Description carries the language it proved, so every pass that reads the descriptor reads
 * the language and none analyzes the patterns again, whatever position it is passed in.
 */
export const registerTextDescriptor = <T extends TextDescriptor>(
	value: T,
	language: Result.Result<PatternLanguage, CompileError>,
	octets: number | undefined
): T => {
	const { patterns } = value
	ownedText.set(value, {
		patterns,
		language,
		described: Result.flatMap(
			Result.map(language, (pattern): FieldDesc => {
				const cut = octets === undefined ? pattern : languageWithin(pattern, octets)
				return deepFreeze({
					kind: "text",
					patterns,
					language: cut,
					bytes: languageOctets(cut)
				})
			}),
			(desc): Result.Result<Described, CompileError> =>
				Result.map(
					scalarTypeOf(desc, bareEnv, SourceLoc(patternsText(patterns), [])),
					(scalar) => ({
						sql: "text",
						desc,
						scalar,
						column: value.column
					})
				)
		)
	})
	return value
}

/**
 * A text descriptor a builder registered (str.regex, str.and, str.bytes): its patterns, their language before any byte
 * bound (RegisteredText), and the byte bound its Description states, none for patterns alone or patterns their analysis
 * refused; undefined for any other value.
 */
export const registeredText = (
	value: unknown
):
	| {
			readonly patterns: Patterns
			readonly language: Result.Result<PatternLanguage, CompileError>
			readonly bytes: number | undefined
	  }
	| undefined => {
	if (!hasProperties(value)) {
		return undefined
	}
	const known = ownedText.get(value)
	if (known === undefined) {
		return undefined
	}
	const desc = known.described.ok ? known.described.value.desc : undefined
	return {
		patterns: known.patterns,
		language: known.language,
		bytes: desc?.kind === "text" ? desc.bytes : undefined
	}
}

/**
 * A value with the brand (core/phantom.ts) that no builder registered as a descriptor: a copy of one, an object spread
 * that keeps the source's host type phantom whatever members it replaces. It is refused, never read by its members.
 */
export const isDescriptorCopy = (value: unknown): boolean =>
	(typeof value === "object" || typeof value === "function") &&
	value !== null &&
	built in value &&
	!owned.has(value) &&
	!ownedText.has(value)

/**
 * What the registry holds for a field descriptor a builder made: an owned descriptor itself, or what a str.regex,
 * str.and or str.bytes descriptor's registration answered (its Description, or the refusal of its patterns); undefined
 * for any other value, which refusedField refuses where it was passed.
 */
export const registeredField = (
	value: unknown
): Result.Result<Described, CompileError> | undefined => {
	if (isOwnedDescriptor(value)) {
		return Result.ok(value)
	}
	if (!hasProperties(value)) {
		return undefined
	}
	const written = writtenFields.get(value)
	return written === undefined ? ownedText.get(value)?.described : registeredField(written)
}

/** Whether a value is a str.regex, str.and or str.bytes descriptor its builder registered (ownedText). */
export const isTextDescriptor = (value: unknown): boolean =>
	hasProperties(value) && ownedText.has(value)

/**
 * Each field of a writing of its own a builder made (schema/relation.ts: a drawn, accumulated, generated or place
 * field), by its value, with the descriptor its values are of, a place's natural among them: where a field
 * descriptor is asked of it, it describes as that value type, one rule for every field, since a caller that states a
 * value typed by it, a parameter's or a relation parameter's column's, states a value of that type. A WeakMap holds
 * nothing alive and is never enumerated, so it is no cache.
 */
const writtenFields = new WeakMap<object, unknown>()

/** `value`, a field of a writing of its own whose values are of the descriptor `type`, registered (writtenFields). */
export const registerWrittenField = (value: object, type: unknown): void => {
	writtenFields.set(value, type)
}

/**
 * Whether a descriptor states a law of its own wherever it types a stored field: a str.regex, str.and or str.bytes
 * text, its pattern law, or a contract, grizzle's own (natural) as any other, its contract's law.
 */
const statesLaw = (value: object): boolean =>
	ownedText.has(value) || (isOwnedDescriptor(value) && value.desc.kind === "domain")

/**
 * A copy of a descriptor that states a law (statesLaw), registered wherever the descriptor it copies is, so every
 * reader reads it as it reads that one: law(...)'s value (schema/law-entries.ts), the copy the catalog entry its author
 * declares is held for, the descriptor copied left as it was. Every own property is copied as it stands onto a record:
 * no descriptor that states a law is a function. Undefined for any other value, which states no law of its own.
 */
export const descriptorCopy = <F extends object>(value: F): F | undefined => {
	if (!statesLaw(value)) {
		return undefined
	}
	const keys = Reflect.ownKeys(value)
	const copy = Object.assign({}, value)
	for (const key of keys) {
		const property = Object.getOwnPropertyDescriptor(value, key)
		if (property !== undefined) {
			Object.defineProperty(copy, key, property)
		}
	}
	Object.freeze(copy)
	if (owned.has(value)) {
		owned.add(copy)
	}
	const text = ownedText.get(value)
	if (text !== undefined) {
		ownedText.set(copy, text)
	}
	const written = writtenFields.get(value)
	if (written !== undefined) {
		writtenFields.set(copy, written)
	}
	return copy
}

/**
 * The descriptor a field of a writing of its own is of (writtenFields): what a drawn, accumulated, generated or place
 * field's values are; none for any other value, a descriptor among them, which is its own type.
 */
export const writtenTypeOf = (value: unknown): unknown =>
	hasProperties(value) ? writtenFields.get(value) : undefined

/**
 * The FieldDesc, ScalarType and column of a field descriptor a builder made, or MalformedDescription, Refused for a
 * spelling of the serial family (scalar/minted.ts). `loc` names the position the descriptor was passed in, for the
 * diagnostic.
 */
export const describeField = (
	value: unknown,
	loc: SourceLoc
): Result.Result<Described, CompileError> => registeredField(value) ?? refusedField(value, loc)

/** The refusal at `loc` of a value that is no field descriptor a builder made: registeredField holds nothing for it. */
export const refusedField = (
	value: unknown,
	loc: SourceLoc
): Result.Result<never, CompileError> => {
	if (value === minted) {
		return Result.err(ruleRefused(loc, mintedRefusal))
	}
	if (!hasProperties(value)) {
		return Result.err(malformedDescription(loc, "a field descriptor"))
	}
	/**
	 * Testing for the brand reads the caller's value, which can run its code (`in` runs a proxy's `has` trap) and throw:
	 * it is read once through hostRead, so a value whose reading throws is refused, never escaping as a defect.
	 */
	const branded = hostRead(
		() =>
			malformedDescription(
				loc,
				"a field descriptor a builder made, whose properties can be read: no refusing proxy"
			),
		() => Result.ok(brandedOf(value))
	)
	return Result.flatMap(branded, (b) => Result.err(malformedDescription(loc, brandedText(b))))
}

/**
 * What a branded value that no builder registered as a descriptor is (isDescriptorCopy): a copy of a descriptor, an
 * object spread; or no branded value at all. A field of a writing of its own is registered (writtenFields).
 */
type Branded = { readonly kind: "copy" } | { readonly kind: "unbranded" }

/** What `value` is, as Branded reads it. */
const brandedOf = (value: unknown): Branded =>
	isDescriptorCopy(value) ? { kind: "copy" } : { kind: "unbranded" }

/** The refusal's text of a value no builder registered as a descriptor, by what it is (Branded). */
const brandedText = (b: Branded): string => {
	switch (b.kind) {
		case "copy":
			return "a field descriptor a builder made: a copy of one (an object spread) is none, because a descriptor's host type is its builder's"
		case "unbranded":
			return "a field descriptor a builder made: int2, int4, int8, numeric, float4, float8, money, bool, inet, cidr, uuid, bytea, exactInteger, exactMoney, str.regex, domain, range, closedId or vector"
	}
}

/** The throwing form, for builders. */
export const describeFieldOrThrow = (value: unknown, loc: SourceLoc): Described => {
	const described = describeField(value, loc)
	if (!described.ok) {
		throw described.error
	}
	return described.value
}

/**
 * The roster of a closed relation by its name: a closedId desc names its roster only (ir/desc.ts), which the registry
 * parses by the characters every relation's name keeps (core/identity.ts parseDerivedName), a declared one's or a
 * derived one's, before it asks. An environment answers with one roster value for each closed
 * relation it holds, so its handles' digest is taken where the environment makes it, never for each field it types.
 */
export type RosterLookup = (name: HeldName) => Roster | undefined

/**
 * The analyzed language of a conjunction of text patterns, before any byte bound cuts it: the text analysis's
 * (text/refinement.ts textLookup), which a text descriptor is admitted with and a lowering types patterns it computes
 * by. The scalar layer reads it through this type alone, since the analysis is the text package's.
 */
export type TextLookup = (patterns: Patterns) => Result.Result<PatternLanguage, CompileError>

/**
 * What a FieldDesc does not say by itself, supplied by whoever resolves it (a text descriptor carries its pattern's
 * language, so none resolves a pattern):
 * - a builder's (a descriptor's own reading, a query's headings, a row check's typing): the rosters it holds. A
 *   contract is identity-only, which is all type identity needs: identity ignores the predicate.
 * - a schema's (the checker's and the law theory's reading of an owned schema): its rosters, and each contract
 *   predicate's expression table (the checker's lowering of the ExprDesc, contractPredicateTable: checked and owned as
 *   the decoder writes it, which the built descriptor holds as it is).
 */
export type ScalarEnv =
	| { readonly kind: "builder"; readonly roster: RosterLookup }
	| {
			readonly kind: "schema"
			readonly roster: RosterLookup
			readonly contractPredicate: (
				predicate: ExprDesc,
				base: ScalarType,
				contract: string,
				facts: ReadonlyArray<Fact>
			) => Result.Result<ExprTable, CompileError>
	  }

/** No closed relation: what a field outside any schema resolves rosters by. */
export const noRosters: RosterLookup = () => undefined

/** The builder environment of a descriptor outside any schema: no rosters. */
export const bareEnv: ScalarEnv = Object.freeze({ kind: "builder", roster: noRosters })

/** A plain value type of `carrier`: no typmod, refinement or contract. */
const plainType = (carrier: BareCarrier | IntegerCarrier | "uuid"): ContractBase =>
	Object.freeze({ carrier, caps: capabilitiesOf(carrier), contract: undefined })

/**
 * A computed numeric of `bound`, frozen (ir/scalar.ts NumericBound), its keys in the decoder's order: an operation's,
 * an aggregate's or a literal's numeric, and at numeric's own limits (ownLimits) numeric of no typmod as numeric
 * declares it.
 */
const numericOfBound = (bound: NumericBound): NumericValueType =>
	Object.freeze({
		carrier: "numeric",
		caps: capabilitiesOf("numeric"),
		typmod: undefined,
		contract: undefined,
		bound: Object.freeze({ digits: bound.digits, scale: bound.scale })
	})

/** A computed numeric of `bound` (numericOfBound). */
export const numericValue = (bound: NumericBound): ScalarType => numericOfBound(bound)

/**
 * numeric of no typmod at numeric's own limits, numericMaxIntegerDigits integer and numericMaxFractionDigits fraction
 * digits: every value numeric holds, NaN and the infinities among them. It is the type numeric declares, and the one
 * a literal adopts and an overload is looked up by (scalar/compute/types.ts anyNumeric): no bound is proved of it but
 * numeric's own, which PostgreSQL enforces.
 */
export const numericOwnLimits: NumericValueType = numericOfBound(numericOwnBound)

/**
 * `carrier`'s exact value at numeric's own limit, frozen, its keys in the decoder's order (ir/scalar-shape.ts), so a
 * declared type and the same type an operation makes (scalar/compute/types.ts exactType) are alike.
 */
const exactAtOwnLimit = (carrier: ExactValueCarrier): DeclaredType =>
	Object.freeze({
		carrier,
		caps: capabilitiesOf(carrier),
		contract: undefined,
		digits: numericMaxIntegerDigits
	})

/**
 * The type each exact field's Description names (ir/desc.ts FieldDesc exact): its carrier's exact value at numeric's
 * own limit, numericMaxIntegerDigits digits (of the amount, for money), which every value integer or money arithmetic
 * delivers lies within, so an exact value of any bound is written into the field as it is.
 */
const exactFieldTypes: { readonly [C in ExactValueCarrier]: DeclaredType } = {
	exactInteger: exactAtOwnLimit("exactInteger"),
	exactMoney: exactAtOwnLimit("exactMoney")
}

/**
 * The type each pg descriptor's Description names (ir/desc.ts PgScalarName): a plain carrier's, and numeric of no
 * typmod at numeric's own limits.
 */
const pgTypes = {
	int2: plainType("int2"),
	int4: plainType("int4"),
	int8: plainType("int8"),
	numeric: numericOwnLimits,
	float4: plainType("float4"),
	float8: plainType("float8"),
	money: plainType("money"),
	bool: plainType("bool"),
	date: plainType("date"),
	inet: plainType("inet"),
	cidr: plainType("cidr")
} as const satisfies { readonly [N in PgScalarName]: DeclaredType }

/**
 * The descriptors are built here, frozen, from a decoded FieldDesc and the environment's resolved metadata, so each
 * is its carrier's variant by construction; the keys follow the decoder's order (ir/scalar.ts), so a built descriptor
 * and its decoded copy are alike.
 */
const scalarAt = (
	desc: FieldDesc,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<DeclaredType, CompileError> => {
	switch (desc.kind) {
		case "pg":
			return Result.ok(pgTypes[desc.type])
		case "numeric":
			return Result.ok(numericType(Object.freeze({ precision: desc.precision, scale: desc.scale })))
		case "exact":
			return Result.ok(exactFieldTypes[desc.carrier])
		case "computedNumeric":
			return Result.ok(numericOfBound(desc.bound))
		case "uuid":
			return Result.ok(plainType("uuid"))
		case "bytes":
			return Result.ok(
				Object.freeze({ carrier: "bytes", caps: capabilitiesOf("bytes"), contract: undefined })
			)
		case "sha256":
			return Result.ok(
				Object.freeze({ carrier: "sha256", caps: capabilitiesOf("sha256"), contract: undefined })
			)
		case "pattern":
			return Result.ok(
				Object.freeze({
					carrier: "text",
					caps: capabilitiesOf("text"),
					contract: undefined,
					text: "pattern"
				})
			)
		case "text":
			return Result.ok(
				Object.freeze({
					carrier: "text",
					caps: capabilitiesOf("text"),
					contract: undefined,
					text: textInfoOf(desc.patterns, desc.language)
				})
			)
		case "closedId":
			return Result.flatMap(rosterAt(desc.roster, env, loc), (roster) =>
				Result.map(subsetIn(roster, desc.only, loc), (only) =>
					Object.freeze({
						carrier: "code",
						caps: closedIdCapabilities(roster),
						contract: undefined,
						roster,
						only
					})
				)
			)
		case "bits":
			return Result.map(rosterAt(desc.roster, env, loc), (roster) =>
				Object.freeze({
					carrier: "bits",
					caps: capabilitiesOf("bits"),
					contract: undefined,
					roster
				})
			)
		case "vector": {
			const dims = desc.dimensions
			return Result.ok(
				Object.freeze({
					carrier: "vector",
					caps: capabilitiesOf("vector"),
					typmod: Object.freeze({ dims }),
					contract: undefined
				})
			)
		}
		case "search":
			return Result.ok(searchType(desc.configuration))
		case "span":
			return Result.flatMap(scalarAt(desc.endpoint, env, childLoc(loc, "endpoint")), (endpoint) =>
				spanType(endpoint, desc.width, loc)
			)
		case "domain":
			return Result.map(contractInfoOf(desc, env, loc), withContract)
		case "variant":
			return variantAt(desc, env, loc)
	}
}

/**
 * Whether a type is a variant arm's field's: any declared type but a variant (a sum is never an arm of another, so a
 * value has one tag), bytes, which are written and read back in chunks of their own, a search document, PostgreSQL's
 * parse of a row's texts, a vector, whose dimensions no record text states, and money, exact or not, which travels as
 * numeric text its statement converts, where a record attribute is read by its own type's input.
 */
const isArmFieldType = (t: DeclaredType): boolean => {
	switch (t.carrier) {
		case "variant":
		case "bytes":
		case "tsvector":
		case "vector":
		case "money":
		case "exactMoney":
			return false
		case "bits":
		case "bool":
		case "cidr":
		case "code":
		case "date":
		case "exactInteger":
		case "float4":
		case "float8":
		case "inet":
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "range4":
		case "range8":
		case "rangeDate":
		case "sha256":
		case "text":
		case "uuid":
			return true
	}
}

/** The name no arm's field takes: the host value's discriminant, which names the arm itself. */
export const variantTagField = "tag"

/**
 * The variant a Description states (ir/desc.ts FieldDesc variant): its declared name; the roster that tags it, resolved
 * as a closed id's is; and its arms, at least one, each of a live handle of the roster, each once, in its handle order,
 * the subset of the roster the variant holds (ir/scalar.ts variantOnly), each field's type resolved as a field's, of a
 * type an arm holds (isArmFieldType), its name unique in its arm and never `tag`. Anything else is
 * MalformedDescription, or refused as its fields' types refuse.
 */
const variantAt = (
	desc: VariantFieldDesc,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<DeclaredType, CompileError> => {
	const name = admitDeclaredName(desc.name, `variant name ${JSON.stringify(desc.name)}`, loc)
	if (!name.ok) {
		return name
	}
	const roster = rosterAt(desc.roster, env, loc)
	if (!roster.ok) {
		return roster
	}
	if (
		!inRosterOrder(
			roster.value,
			desc.arms.map((arm) => arm.handle)
		)
	) {
		return Result.err(
			malformedDescription(
				loc,
				`a variant's arms, each of a handle of ${roster.value.closed}, each once in its order (${roster.value.handles.join(", ")})`
			)
		)
	}
	const arms: Array<VariantArm> = []
	for (const arm of desc.arms) {
		const armLoc = childLoc(loc, arm.handle)
		const seen = new Set<string>()
		const fields: Array<ArmField> = []
		for (const field of arm.fields) {
			if (field.name === variantTagField) {
				return Result.err(
					ruleRefused(
						childLoc(armLoc, field.name),
						"a variant arm's field is named apart from tag, which names its arm"
					)
				)
			}
			if (seen.has(field.name) || !parseDeclaredName(field.name).ok) {
				return Result.err(
					malformedDescription(armLoc, "an arm's fields, each named once by a declared name")
				)
			}
			seen.add(field.name)
			const fieldLoc = childLoc(armLoc, field.name)
			const type = scalarAt(field.desc, env, fieldLoc)
			if (!type.ok) {
				return type
			}
			if (!isArmFieldType(type.value)) {
				return Result.err(
					ruleRefused(
						fieldLoc,
						"a variant arm's field is a value of a type that is no variant, bytea, search document, vector or money"
					)
				)
			}
			fields.push(Object.freeze({ name: field.name, type: type.value }))
		}
		arms.push(
			Object.freeze({ handle: arm.handle, fields: Object.freeze(fields), check: undefined })
		)
	}
	const [first, ...rest] = arms
	if (first === undefined) {
		return Result.err(
			ruleRefused(loc, "a variant holds at least one arm, each named by a handle of its roster")
		)
	}
	const unchecked = variantType(name.value, roster.value, [first, ...rest])
	if (env.kind === "builder" || desc.arms.every((arm) => arm.check === undefined)) {
		return Result.ok(unchecked)
	}
	/** Each arm's check typed over the variant's VALUE, of the variant its fields make, as a contract's predicate is. */
	const checked: Array<VariantArm> = []
	for (const [i, arm] of [first, ...rest].entries()) {
		const check = desc.arms[i]?.check
		if (check === undefined) {
			checked.push(arm)
			continue
		}
		const table = env.contractPredicate(check, unchecked, `${name.value}.${arm.handle}`, [])
		if (!table.ok) {
			return table
		}
		checked.push(Object.freeze({ ...arm, check: table.value }))
	}
	const [head, ...tail] = checked
	return Result.ok(
		variantType(name.value, roster.value, [defined(head, "a variant's first arm"), ...tail])
	)
}

/** The variant type of `name` over `roster` with `arms`, frozen, its keys in the decoder's order (ir/scalar-shape.ts). */
const variantType = (
	name: DeclaredName,
	roster: Roster,
	arms: NonEmptyReadonlyArray<VariantArm>
): VariantType =>
	Object.freeze({
		carrier: "variant",
		caps: capabilitiesOf("variant"),
		contract: undefined,
		variant: Object.freeze({ name, roster, arms: Object.freeze(arms) })
	})

/**
 * The type of a variant's tag (scalar/compute/typing.ts variant), frozen, its keys in the decoder's order: a closed id of
 * its roster holding the handles its arms name (ir/scalar.ts variantOnly), as closedId(roster, { only }) holds its
 * subset's, every handle where its arms name every one.
 */
export const variantTagType = (variant: VariantInfo): DeclaredType =>
	Object.freeze({
		carrier: "code",
		caps: closedIdCapabilities(variant.roster),
		contract: undefined,
		roster: variant.roster,
		only: variantOnly(variant)
	})

/**
 * A closed id's capabilities, by its roster's order: an ordered roster's are the code carrier's, and an unordered or a
 * zone roster's have no ordering and no minMax (unorderedCodeCapabilities).
 */
const closedIdCapabilities = (roster: Roster): CapabilitySet => {
	switch (roster.order) {
		case "ordered":
			return capabilitiesOf("code")
		case "unordered":
		case "zones":
			return capabilitySet(unorderedCodeCapabilities)
	}
}

/**
 * The roster a closed id or a set names, by the closed relation's name, as its environment holds it: a name of
 * characters no relation's name keeps, or no closed relation's, is MalformedDescription.
 */
const rosterAt = (
	closed: string,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<Roster, CompileError> => {
	const name = parseDerivedName(closed)
	const roster = name.ok ? env.roster(name.value) : undefined
	return roster === undefined
		? Result.err(malformedDescription(loc, `a closed relation named ${JSON.stringify(closed)}`))
		: Result.ok(roster)
}

/**
 * A closed id's subset `only` of `roster`, as its Description states it (ir/desc.ts FieldDesc): live handles of the
 * roster, in its order, short of every handle, which is the closed id of the whole roster, none; or none. Any other is
 * MalformedDescription, so one subset has one spelling.
 */
const subsetIn = (
	roster: Roster,
	only: NonEmptyReadonlyArray<string> | undefined,
	loc: SourceLoc
): Result.Result<NonEmptyReadonlyArray<string> | undefined, CompileError> => {
	if (only === undefined) {
		return Result.ok(undefined)
	}
	return isRosterSubset(roster, only)
		? Result.ok(only)
		: Result.err(
				malformedDescription(
					loc,
					`a closed id's subset of handles of ${roster.closed}, each once in its order, short of every handle`
				)
			)
}

/** A span's endpoint through its contracts: the declaration its carrier is read off. */
const endpointBase = (desc: FieldDesc): FieldDesc =>
	desc.kind === "domain" ? endpointBase(desc.base) : desc

/**
 * The capability set of the type a FieldDesc declares, read off its carrier alone, before its rosters or a contract's
 * predicate are resolved: a contract's is its base's, as scalarAt gives it, and a span's its range carrier's. What a
 * declaration may take part in, a key or a law's side, is read here, off the capability set, never off a kind's name.
 */
export const descCapabilities = (desc: FieldDesc): CapabilitySet => {
	switch (desc.kind) {
		case "pg":
			return capsOf(pgTypes[desc.type])
		case "numeric":
		case "computedNumeric":
			return capabilitiesOf("numeric")
		case "exact":
			return capabilitiesOf(desc.carrier)
		case "uuid":
			return capabilitiesOf("uuid")
		case "bytes":
			return capabilitiesOf("bytes")
		case "sha256":
			return capabilitiesOf("sha256")
		case "text":
		case "pattern":
			return capabilitiesOf("text")
		case "closedId":
			return capabilitiesOf("code")
		case "bits":
			return capabilitiesOf("bits")
		case "vector":
			return capabilitiesOf("vector")
		case "search":
			return capabilitiesOf("tsvector")
		case "span": {
			const endpoint = endpointBase(desc.endpoint)
			return capabilitiesOf(
				endpoint.kind === "pg" && endpoint.type === "date"
					? "rangeDate"
					: endpoint.kind === "pg" && endpoint.type === "int8"
						? "range8"
						: "range4"
			)
		}
		case "domain":
			return descCapabilities(desc.base)
		case "variant":
			return capabilitiesOf("variant")
	}
}

/**
 * A search document of `configuration` (ir/scalar.ts SearchType), its keys in the decoder's order (ir/scalar-shape.ts),
 * so a built type and its decoded copy are alike.
 */
export const searchType = (configuration: TextSearchConfiguration): DeclaredType =>
	Object.freeze({
		carrier: "tsvector",
		caps: capabilitiesOf("tsvector"),
		contract: undefined,
		configuration
	})

const numericType = (typmod: NumericTypmod): ContractBase =>
	Object.freeze({
		carrier: "numeric",
		caps: capabilitiesOf("numeric"),
		typmod,
		contract: undefined
	})

/**
 * A span over `endpoint`: range4 over integer, range8 over bigint and rangeDate over date, through contracts, refused
 * with a capability diagnostic for any other endpoint.
 */
export const spanType = (
	endpoint: ScalarType,
	width: bigint | undefined,
	loc: SourceLoc
): Result.Result<Extract<ScalarType, { readonly carrier: SpanCarrier }>, CompileError> => {
	if (isDateType(endpoint)) {
		return Result.ok(
			Object.freeze({
				carrier: "rangeDate",
				caps: capabilitiesOf("rangeDate"),
				contract: undefined,
				span: Object.freeze({ endpoint, width })
			})
		)
	}
	if (endpoint.carrier !== "int4" && endpoint.carrier !== "int8") {
		return Result.err(
			capabilityError(loc, "spanEndpoint", `${typeLabel(endpoint)} ${spanEndpointDetail(endpoint)}`)
		)
	}
	const carrier = endpoint.carrier === "int4" ? "range4" : "range8"
	return Result.ok(
		Object.freeze({
			carrier,
			caps: capabilitiesOf(carrier),
			contract: undefined,
			span: Object.freeze({ endpoint, width })
		})
	)
}

/**
 * The descriptor of a contract over its base: the base's carrier, by which every switch on carriers reads it, and the
 * contract, whose base holds the rest (ir/scalar.ts ContractType).
 */
const withContract = (contract: ContractInfo): ContractBase =>
	Object.freeze({ carrier: contract.base.carrier, contract })

/**
 * A nominal contract over `base`: the base's carrier, typmod, refinements and capabilities, the contract's
 * name, the facts it declares it proves, and the predicate table when the checker supplies one (undefined from a
 * builder, which needs none). A contract over a set over a roster is refused UnsupportedOperation.
 */
export const contractType = (
	name: DeclaredName,
	base: DeclaredType,
	loc: SourceLoc,
	predicate: ExprTable | undefined,
	facts: ReadonlyArray<Fact>
): Result.Result<ContractBase, CompileError> =>
	Result.map(contractOver(name, base, loc, predicate, facts), withContract)

/**
 * The contract `name` over `base` with `predicate`'s table, frozen with a frozen copy of its facts, so it holds no
 * array its caller made: a contract over a set, bytes, a search document or an exact value is refused.
 */
const contractOver = (
	name: DeclaredName,
	base: DeclaredType,
	loc: SourceLoc,
	predicate: ExprTable | undefined,
	facts: ReadonlyArray<Fact>
): Result.Result<ContractInfo, CompileError> => {
	if (base.carrier === "bits") {
		return Result.err(
			unsupported(
				loc,
				`contractBase: ${typeLabel(base)} is a set over a roster, whose hole and padding bits no predicate keeps apart; no domain is over one`
			)
		)
	}
	if (base.carrier === "bytes") {
		return Result.err(
			capabilityError(
				loc,
				"equality",
				`${typeLabel(base)} is stored only, so no predicate reads it; no domain is over bytea`
			)
		)
	}
	if (base.carrier === "sha256") {
		return Result.err(
			unsupported(
				loc,
				`contractBase: ${typeLabel(base)} is a digest, whose one predicate is its length, which its domain holds; no domain is over one`
			)
		)
	}
	if (base.carrier === "tsvector") {
		return Result.err(
			capabilityError(
				loc,
				"textSearch",
				`${typeLabel(base)} is a search document, PostgreSQL's parse of its row's texts, which no predicate reads; no domain is over one`
			)
		)
	}
	if (isExactValue(base)) {
		return Result.err(
			ruleRefused(
				loc,
				"no domain is over an exact value of any size: declare it over int8, numeric(p, s) or money"
			)
		)
	}
	if (base.carrier === "variant") {
		return Result.err(
			ruleRefused(
				loc,
				"no domain is over a variant: its domain holds its arms, and each arm field's type holds its own predicate"
			)
		)
	}
	return Result.ok(Object.freeze({ name, base, predicate, facts: Object.freeze([...facts]) }))
}

/**
 * The contract a contract descriptor declares: its name, parsed as a declared name, its base's value type and, in a
 * schema, its predicate's table (`ScalarEnv`). A name the declared-name rule refuses is MalformedDescription; otherwise
 * refused as its base, its predicate or `contractType` refuses.
 */
export const contractInfoOf = (
	desc: ContractFieldDesc,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<ContractInfo, CompileError> => {
	const name = admitDeclaredName(desc.name, `domain name ${JSON.stringify(desc.name)}`, loc)
	if (!name.ok) {
		return name
	}
	return Result.flatMap(scalarAt(desc.base, env, childLoc(loc, "base")), (base) =>
		env.kind === "builder" || desc.predicate === undefined
			? contractOver(name.value, base, loc, undefined, desc.facts)
			: Result.flatMap(
					env.contractPredicate(desc.predicate, base, desc.name, desc.facts),
					(predicate) => contractOver(name.value, base, loc, predicate, desc.facts)
				)
	)
}

/**
 * The declared type of a FieldDesc (ir/scalar.ts DeclaredType): carrier, typmod, bound, refinements and capability set,
 * a computed numeric's and an exact field's among them. A span over an endpoint without the
 * spanEndpoint capability is a capability diagnostic and a contract over a set a refusal (both UnsupportedOperation); an unknown roster, and a contract name the declared-name rule refuses, is MalformedDescription.
 */
export const scalarTypeOf = (
	desc: FieldDesc,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<DeclaredType, CompileError> => scalarAt(desc, env, loc)

/**
 * The descriptor of numeric of no typmod within `bound` (ir/desc.ts FieldDesc): a computed numeric of it, or
 * numeric where the bound is numeric's own limits, the one descriptor of that type.
 */
export const numericBoundDesc = (bound: NumericBound): FieldDesc =>
	bound.digits === numericOwnBound.digits && bound.scale === numericOwnBound.scale
		? { kind: "pg", type: "numeric" }
		: { kind: "computedNumeric", bound }
