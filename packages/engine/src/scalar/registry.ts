import type { Columned } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription, unsupported } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import { defect } from "#compiler/core/invariant.ts"
import { captureLoc, childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { type Built, built, builtMark } from "#compiler/core/phantom.ts"
import { deepFreeze, hasProperties } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import {
	baseOf,
	type Capability,
	type CapabilitySet,
	capabilitySet,
	type Carrier,
	type ContractBase,
	type ContractInfo,
	type DeclaredType,
	isDateType,
	languageOctets,
	languageWithin,
	type NumericBound,
	type NumericTypmod,
	type PatternLanguage,
	type Patterns,
	patternsText,
	type Roster,
	type ScalarType,
	type SpanCarrier,
	textInfoOf,
	typeLabel
} from "#compiler/ir/scalar.ts"
import { literalDescFor } from "#compiler/scalar/literal.ts"
import { nativeCapabilities } from "#compiler/scalar/native.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"

/** The capability set of a carrier. */
export const capabilitiesOf = (carrier: Carrier): CapabilitySet =>
	capabilitySet(nativeCapabilities[carrier])

export const hasCapability = (t: ScalarType, capability: Capability): boolean =>
	t.caps.includes(capability)

/**
 * Whether a type is stored only: its capability set is storage alone, so a value of it is written and read back whole
 * and nothing more. No operation reads one, no parameter carries one, and neither PostgreSQL nor grizzle writes a field
 * of one; bytes is such a carrier (nativeCapabilities). Each of those refusals reads it here, off the capability set,
 * never off the carrier's name.
 */
export const storedOnly = (t: ScalarType): boolean => t.caps.every((c) => c === "storage")

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
		return "is money, for which no span is admitted"
	}
	return "is not an admitted span endpoint; spans are over integer, bigint, date and contracts over them"
}

/** The PostgreSQL type names of descriptors, the `sql` member of each. */
export const carrierSql = {
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
	code: "code",
	bits: "bits",
	range4: "range",
	range8: "range",
	rangeDate: "range",
	vector: "vector",
	exactInteger: "exact integer",
	exactMoney: "exact money"
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
 * Every field descriptor (pg.*, uuid, contract, span, closedId, pg.vector, the serial family, and str.regex) is an
 * owned, frozen value that carries, beside its public members (its SQL name and its column, core/decoder.ts, whose
 * values are its host type), two internal ones:
 *
 * - `desc`, its FieldDesc: the descriptor as it crosses the Description boundary (ir/desc.ts), aliases already
 *   normalized, so `pg.int`, `pg.int4` and `pg.integer` have one Description;
 * - `scalar`, its ScalarType: the IR identity with its operation capability set (ir/scalar.ts).
 *
 * `describeField` reads them from any descriptor a caller hands in, and admits a descriptor only by identity: one this
 * package defined, or a str.regex descriptor its builder registered, which is read from its pattern. Anything else, a
 * JavaScript caller's look-alike or a copy of a descriptor, is CompileError MalformedDescription: a value no builder
 * made has no column a builder made, so nothing could deliver its values.
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
export interface Descriptor<out Sql extends SqlTag = SqlTag> extends Described<Sql>, Built {}

/** Descriptors this package defined. A WeakSet holds no descriptor alive and is never enumerated, so it is no cache. */
const owned = new WeakSet<object>()

/**
 * Freezes `target` with its members, registers it as an owned descriptor, and returns it. `target` is an object or,
 * for a value-and-callable descriptor (pg.numeric, pg.float, a contract), a function. Every member is non-writable;
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
	return hasProperties(value) ? ownedText.get(value)?.described : undefined
}

/**
 * The FieldDesc, ScalarType and column of a field descriptor a builder made, or MalformedDescription. `loc` names
 * the position the descriptor was passed in, for the diagnostic.
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
	if (!hasProperties(value)) {
		return Result.err(malformedDescription(loc, "a field descriptor"))
	}
	/**
	 * Testing for the brand reads the caller's value, which can run its code (`in` runs a proxy's `has` trap) and throw:
	 * it is read once through hostRead, so a value whose reading throws is refused, never escaping as a defect.
	 */
	const copy = hostRead(
		() =>
			malformedDescription(
				loc,
				"a field descriptor a builder made, whose properties can be read: no refusing proxy"
			),
		() => Result.ok(isDescriptorCopy(value))
	)
	return Result.flatMap(copy, (isCopy) =>
		Result.err(
			malformedDescription(
				loc,
				isCopy
					? "a field descriptor a builder made: a copy of one (an object spread) is none, because a descriptor's host type is its builder's"
					: "a field descriptor a builder made: pg.*, uuid, bytes, str.regex, contract, span, closedId or pg.vector"
			)
		)
	)
}

/** The throwing form, for builders. */
export const describeFieldOrThrow = (value: unknown, loc: SourceLoc): Described => {
	const described = describeField(value, loc)
	if (!described.ok) {
		throw described.error
	}
	return described.value
}

/** A serial by its name, and the value type it is written over, which a contract's base or a span's endpoint takes. */
export interface SerialName {
	readonly serial: string
	readonly value: string
}

/** Each serial by the carrier of the value type it is written over: an integer's, or the uuid pg.uuidv7 draws. */
const serialNames = {
	int2: { serial: "pg.smallserial", value: "pg.smallint" },
	int4: { serial: "pg.serial", value: "pg.integer" },
	int8: { serial: "pg.bigserial", value: "pg.bigint" },
	uuid: { serial: "pg.uuidv7", value: "uuid" }
} as const

/**
 * The serial a descriptor `describeField` read is (pg.serial, over pg.integer), or undefined for a field its caller
 * writes. A serial's type and Description are its value type's (scalar/serial.ts), so only its writing tells it apart:
 * the descriptor's `writing` member, the one a relation reads a field's writing from (schema/relation.ts writingOf). It
 * is a generation declaration, not a value type, so a contract's base and a span's endpoint are never one.
 */
export const serialNameOf = (described: Described): SerialName | undefined => {
	if (!("writing" in described) || described.writing !== "serial") {
		return undefined
	}
	const { carrier } = described.scalar
	if (carrier !== "int2" && carrier !== "int4" && carrier !== "int8" && carrier !== "uuid") {
		throw defect(`a serial descriptor of ${carrier}, which no serial is written over`)
	}
	return serialNames[carrier]
}

/**
 * The roster of a closed relation by its declared name: a closedId desc names its roster only (ir/desc.ts), which the
 * registry parses as a declared name before it asks. An environment answers with one roster value for each closed
 * relation it holds, so its handles' digest is taken where the environment makes it, never for each field it types.
 */
export type RosterLookup = (name: DeclaredName) => Roster | undefined

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

const pgCarriers = {
	smallint: "int2",
	integer: "int4",
	bigint: "int8",
	real: "float4",
	"double precision": "float8",
	money: "money",
	boolean: "bool",
	date: "date"
} as const

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
		case "pg": {
			const carrier = pgCarriers[desc.type]
			return Result.ok(plainType(carrier))
		}
		case "numeric":
			return Result.ok(numericType(Object.freeze({ precision: desc.precision, scale: desc.scale })))
		case "uuid":
			return Result.ok(plainType("uuid"))
		case "bytes":
			return Result.ok(Object.freeze({ carrier: "bytes", caps: capabilitiesOf("bytes") }))
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
			return Result.map(rosterAt(desc.roster, env, loc), (roster) =>
				Object.freeze({
					carrier: "code",
					caps: capabilitiesOf("code"),
					contract: undefined,
					roster
				})
			)
		case "bits":
			return Result.map(rosterAt(desc.roster, env, loc), (roster) =>
				Object.freeze({ carrier: "bits", caps: capabilitiesOf("bits"), roster })
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
		case "span":
			return Result.flatMap(scalarAt(desc.endpoint, env, childLoc(loc, "endpoint")), (endpoint) =>
				spanType(endpoint, desc.width, loc)
			)
		case "contract":
			return Result.map(contractInfoOf(desc, env, loc), (info) => withContract(info.base, info))
	}
}

/**
 * The roster a closed id or a set names, by the closed relation's declared name, as its environment holds it: a name
 * the declared-name rule refuses, or no closed relation's, is MalformedDescription.
 */
const rosterAt = (
	closed: string,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<Roster, CompileError> => {
	const name = parseDeclaredName(closed)
	const roster = name.ok ? env.roster(name.value) : undefined
	return roster === undefined
		? Result.err(malformedDescription(loc, `a closed relation named ${JSON.stringify(closed)}`))
		: Result.ok(roster)
}

/** A span's endpoint through its contracts: the declaration its carrier is read off. */
const endpointBase = (desc: FieldDesc): FieldDesc =>
	desc.kind === "contract" ? endpointBase(desc.base) : desc

/**
 * The capability set of the type a FieldDesc declares, read off its carrier alone, before its rosters or a contract's
 * predicate are resolved: a contract's is its base's, as scalarAt gives it, and a span's its range carrier's. What a
 * declaration may take part in, a key or a law's side, is read here, off the capability set, never off a kind's name.
 */
export const descCapabilities = (desc: FieldDesc): CapabilitySet => {
	switch (desc.kind) {
		case "pg":
			return capabilitiesOf(pgCarriers[desc.type])
		case "numeric":
			return capabilitiesOf("numeric")
		case "uuid":
			return capabilitiesOf("uuid")
		case "bytes":
			return capabilitiesOf("bytes")
		case "text":
			return capabilitiesOf("text")
		case "closedId":
			return capabilitiesOf("code")
		case "bits":
			return capabilitiesOf("bits")
		case "vector":
			return capabilitiesOf("vector")
		case "span": {
			const endpoint = endpointBase(desc.endpoint)
			return capabilitiesOf(
				endpoint.kind === "pg" && endpoint.type === "date"
					? "rangeDate"
					: endpoint.kind === "pg" && endpoint.type === "bigint"
						? "range8"
						: "range4"
			)
		}
		case "contract":
			return descCapabilities(desc.base)
	}
}

/** A plain value type of `carrier`: no typmod, refinement or contract. */
const plainType = (carrier: (typeof pgCarriers)[keyof typeof pgCarriers] | "uuid"): ContractBase =>
	Object.freeze({ carrier, caps: capabilitiesOf(carrier), contract: undefined })

const numericType = (typmod: NumericTypmod): ContractBase =>
	Object.freeze({
		carrier: "numeric",
		caps: capabilitiesOf("numeric"),
		typmod,
		contract: undefined
	})

/**
 * A computed numeric of `bound`, frozen (ir/scalar.ts NumericBound), its keys in the decoder's order: an operation's,
 * an aggregate's or a literal's numeric, which no declaration states.
 */
export const numericValue = (bound: NumericBound): ScalarType =>
	Object.freeze({
		carrier: "numeric",
		caps: capabilitiesOf("numeric"),
		typmod: undefined,
		contract: undefined,
		bound: Object.freeze({ digits: bound.digits, scale: bound.scale })
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
 * The descriptor of a contract over `base`: the base's carrier, typmod, refinements and capabilities, each field the
 * base's variant states, beside the contract.
 */
const withContract = (base: ContractBase, contract: ContractInfo): ContractBase =>
	Object.freeze({ ...base, contract })

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
	Result.map(contractOver(name, base, loc, predicate, facts), (info) =>
		withContract(info.base, info)
	)

/**
 * The contract `name` over `base` with `predicate`'s table, frozen with a frozen copy of its facts, so it holds no
 * array its caller made: a contract over a set is refused.
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
				`contractBase: ${typeLabel(base)} is a set over a roster, whose hole and padding bits no predicate keeps apart; no contract is over one`
			)
		)
	}
	if (base.carrier === "bytes") {
		return Result.err(
			capabilityError(
				loc,
				"equality",
				`${typeLabel(base)} is stored only, so no predicate reads it; no contract is over bytes`
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
	desc: Extract<FieldDesc, { readonly kind: "contract" }>,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<ContractInfo, CompileError> => {
	const name = parseDeclaredName(desc.name)
	if (!name.ok) {
		return Result.err(
			malformedDescription(
				loc,
				`the declared contract name ${JSON.stringify(desc.name)} as ${name.error}`
			)
		)
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
 * The declared type of a FieldDesc (ir/scalar.ts DeclaredType): carrier, typmod, refinements and capability set, never
 * a computed numeric or an exact value, which no declaration states. A span over an endpoint without the
 * spanEndpoint capability is a capability diagnostic and a contract over a set a refusal (both UnsupportedOperation); an unknown roster, and a contract name the declared-name rule refuses, is MalformedDescription.
 */
export const scalarTypeOf = (
	desc: FieldDesc,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<DeclaredType, CompileError> => scalarAt(desc, env, loc)

/** The throwing form, for builders: a literal of the wrong host kind is MalformedDescription naming what was needed. */
export const literalDescOrThrow = (t: ScalarType, value: unknown, label: string): LiteralDesc => {
	const literal = literalDescFor(t, value)
	if (!literal.ok) {
		throw malformedDescription(captureLoc(label, []), describeFault(literal.error))
	}
	return literal.value
}
