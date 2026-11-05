import type { Columned } from "#compiler/core/decoder.ts"
import {
	type CompileError,
	malformedDescription,
	unsupported,
	type ValueFault
} from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import { captureLoc, childLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Built, built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { validateText } from "#compiler/core/text.ts"
import { decodeDesc, type ExprDesc, type FieldDesc, type LiteralDesc } from "#compiler/ir/desc.ts"
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
	type NumericBound,
	type NumericTypmod,
	type RegexRef,
	type ScalarType,
	type SpanCarrier,
	serialCarriers,
	type TextInfo,
	typeLabel,
	type ValueType
} from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { unreadableFault } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"

/** The native capabilities of each carrier, as const so the type level reads the same table (types/fields). */
export const nativeCapabilities = {
	int2: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"storage",
		"sum"
	],
	int4: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"spanEndpoint",
		"storage",
		"sum"
	],
	int8: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"spanEndpoint",
		"storage",
		"sum"
	],
	numeric: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"storage",
		"sum"
	],
	float4: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"storage",
		"sum"
	],
	float8: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"storage",
		"sum"
	],
	/** No hash operator class and no avg(money). */
	money: ["equality", "expressionIndex", "gist", "minMax", "ordering", "storage", "sum"],
	/** r.min and r.max lower to bool_and and bool_or; there is no min(boolean), sum or avg. */
	bool: ["boolAgg", "equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	/** PostgreSQL 19 has no min(uuid) or max(uuid). */
	uuid: ["equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	text: ["equality", "expressionIndex", "gist", "hashing", "minMax", "ordering", "storage"],
	enum: ["equality", "expressionIndex", "gist", "hashing", "minMax", "ordering", "storage"],
	/** No min or max over a range; GiST is range_ops, the operator class every Allen atom uses. */
	range4: ["equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	range8: ["equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	/**
	 * pgvector's B-tree vector_ops gives equality and vector_cmp order; there is no hash or GiST class,
	 * and its sum and avg are not language aggregates. vectorDistance is cosine_distance over the cosine domain.
	 */
	vector: ["equality", "ordering", "storage", "vectorDistance"],
	/** Numeric's operations over integers, never a field's: no storage, no GiST. */
	exactInteger: ["avg", "equality", "expressionIndex", "hashing", "minMax", "ordering", "sum"],
	/** Numeric's over amounts at scale 2, reached through money's STABLE cast: no expression index, no avg. */
	exactMoney: ["equality", "hashing", "minMax", "ordering", "sum"]
} as const satisfies { readonly [C in Carrier]: ReadonlyArray<Capability> }

/** The capability set of a carrier; a serial generation declaration has no span endpoint. */
export const capabilitiesOf = (carrier: Carrier, serial: boolean): CapabilitySet => {
	const native: ReadonlyArray<Capability> = nativeCapabilities[carrier]
	const caps = native.filter((c) => !(serial && c === "spanEndpoint"))
	return capabilitySet(caps)
}

export const hasCapability = (t: ScalarType, capability: Capability): boolean =>
	t.caps.includes(capability)

/**
 * A capability diagnostic: UnsupportedOperation, its capability naming the
 * registry capability first, then what lacks it and why.
 */
const capabilityError = (loc: SourceLoc, capability: Capability, detail: string): CompileError =>
	unsupported(loc, `${capability}: ${detail}`)

/** Why a type is not a span endpoint: integer, bigint and contracts over them only, never a serial. */
const spanEndpointDetail = (t: ScalarType): string => {
	if ("serial" in t) {
		return "is a serial generation declaration; use its integer type"
	}
	const base = baseOf(t)
	if (base.carrier === "money") {
		return "is money, for which no span is admitted"
	}
	return "is not an admitted span endpoint; spans are over integer, bigint and contracts over them"
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
	text: "text",
	enum: "enum",
	range4: "range",
	range8: "range",
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
 * A serial keeps its integer's, less spanEndpoint. Every vector has vectorDistance: its
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
 * Defines a descriptor from its Description: the ScalarType is the registry's reading of `desc` (scalarTypeOf), so a
 * descriptor's two internal forms cannot disagree. Its column is one of its members, which its builder made from its
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
	const decoded = decodeDesc("field", desc)
	if (!decoded.ok) {
		throw decoded.error
	}
	const scalar = scalarTypeOf(decoded.value, env, loc)
	if (!scalar.ok) {
		throw scalar.error
	}
	return defineDescriptor(target, { sql, desc: decoded.value, scalar: scalar.value }, members)
}

export const isOwnedDescriptor = (value: unknown): value is Described =>
	(typeof value === "object" || typeof value === "function") && value !== null && owned.has(value)

/** What a str.regex descriptor is read from: its pattern and its column. */
interface TextDescriptor extends Built, Columned<unknown> {
	readonly pattern: { readonly source: string; readonly flags: string }
}

/**
 * The str.regex descriptors text/field.ts made, each with what describeField answers for it: its Description, its
 * ScalarType, its pattern analyzed once, when its builder registered it, and its column, or the refusal of its
 * pattern. A WeakMap holds nothing alive and is never enumerated.
 */
const ownedText = new WeakMap<object, Result.Result<Described, CompileError>>()

/**
 * Registers `value`, a frozen str.regex descriptor its builder made, with its pattern analyzed by `text`, and returns
 * it. A text type's analysis reads its pattern alone, so the descriptor is described once whatever position it is
 * passed in.
 */
export const registerTextDescriptor = <T extends TextDescriptor>(value: T, text: TextLookup): T => {
	const { source, flags } = value.pattern
	const env: ScalarEnv = { kind: "builder", roster: noRosters, text }
	ownedText.set(
		value,
		Result.flatMap(
			decodeDesc("field", { kind: "text", source, flags }),
			(desc): Result.Result<Described, CompileError> =>
				Result.map(scalarTypeOf(desc, env, SourceLoc(`/${source}/${flags}`, [])), (scalar) => ({
					sql: "text",
					desc,
					scalar,
					column: value.column
				}))
		)
	)
	return value
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

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value)

/**
 * The FieldDesc, ScalarType and column of a field descriptor a builder made, or MalformedDescription. `loc` names
 * the position the descriptor was passed in, for the diagnostic.
 */
export const describeField = (
	value: unknown,
	loc: SourceLoc
): Result.Result<Described, CompileError> => {
	if (isOwnedDescriptor(value)) {
		return Result.ok(value)
	}
	if (!hasProperties(value)) {
		return Result.err(malformedDescription(loc, "a field descriptor"))
	}
	/** A str.regex descriptor: its regex is its Description; str.regex owns the rest of its metadata. */
	const regex = ownedText.get(value)
	if (regex !== undefined) {
		return regex
	}
	/**
	 * Testing for the brand reads the caller's value, which can run its code (`in` runs a proxy's `has` trap) and throw:
	 * it is read once through hostRead, so a value whose reading throws is refused, never escaping as a defect.
	 */
	const copy = hostRead(
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
					: "a field descriptor a builder made: pg.*, uuid, str.regex, contract, span, closedId or pg.vector"
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

/**
 * The handles of a closed relation by its declared name: a closedId desc names its roster only (ir/desc.ts), which the
 * registry parses as a declared name before it asks.
 */
type RosterLookup = (name: DeclaredName) => NonEmptyReadonlyArray<string> | undefined

/**
 * The regex metadata of a text pattern: the text analysis's (text/refinement.ts textLookup), which computes its
 * language's key.
 */
export type TextLookup = (
	source: string,
	flags: "u" | "su"
) => Result.Result<TextInfo, CompileError>

/**
 * What a FieldDesc does not say by itself, supplied by whoever resolves it:
 * - a builder's (a descriptor's own reading, a query's headings, a row check's typing): the rosters and text metadata
 *   it holds. A contract is identity-only, which is all type identity needs: identity ignores the predicate.
 * - a schema's (the checker's and the law theory's reading of an owned schema): its rosters, the text analysis's
 *   canonical metadata, and each contract predicate's expression table (the checker's lowering of the ExprDesc,
 *   contractPredicateTable: checked and owned as the decoder writes it, which the built descriptor holds as it is).
 */
export type ScalarEnv =
	| { readonly kind: "builder"; readonly roster: RosterLookup; readonly text: TextLookup }
	| {
			readonly kind: "schema"
			readonly roster: RosterLookup
			readonly text: TextLookup
			readonly contractPredicate: (
				predicate: ExprDesc,
				base: ScalarType,
				contract: string,
				facts: ReadonlyArray<Fact>
			) => Result.Result<ExprTable, CompileError>
	  }

/** No closed relation: what a field outside any schema resolves rosters by. */
export const noRosters: RosterLookup = () => undefined

/**
 * No pattern: what a descriptor that holds no text field resolves patterns by. A str.regex descriptor carries the text
 * analysis it is read by, and a schema or a query resolves patterns by the text analysis, so only a field read under
 * the wrong environment meets this.
 */
export const noText: TextLookup = (source, flags) =>
	Result.err(
		malformedDescription(
			SourceLoc(`/${source}/${flags}`, []),
			"a pattern the text analysis reads: a str.regex descriptor's own"
		)
	)

/** The builder environment of a descriptor outside any schema that holds no text field: no rosters and no pattern. */
export const bareEnv: ScalarEnv = Object.freeze({
	kind: "builder",
	roster: noRosters,
	text: noText
})

const pgCarriers = {
	smallint: "int2",
	integer: "int4",
	bigint: "int8",
	real: "float4",
	"double precision": "float8",
	money: "money",
	boolean: "bool"
} as const

/** A regex reference as the environment holds it, deeply frozen as a decoded descriptor holds it: one already frozen is
 * shared. */
const ownedRegex = (regex: RegexRef): RegexRef =>
	Object.isFrozen(regex)
		? regex
		: Object.freeze({ source: regex.source, flags: regex.flags, key: regex.key })

const ownedTextInfo = (text: TextInfo): TextInfo => {
	const { regex } = text
	if (Object.isFrozen(text) && (regex === "wildcard" || Object.isFrozen(regex))) {
		return text
	}
	if (text.lengthBound !== undefined) {
		return Object.freeze({
			regex: ownedRegex(text.regex),
			lengthBound: text.lengthBound,
			byteBound: text.byteBound
		})
	}
	return Object.freeze({
		regex: regex === "wildcard" ? regex : ownedRegex(regex),
		lengthBound: undefined,
		byteBound: undefined
	})
}

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
		case "serial": {
			const carrier = serialCarriers[desc.type]
			return Result.ok(
				Object.freeze({ carrier, caps: capabilitiesOf(carrier, true), serial: "always" })
			)
		}
		case "uuid":
			return Result.ok(plainType("uuid"))
		case "text":
			return Result.map(env.text(desc.source, desc.flags), (info) =>
				Object.freeze({
					carrier: "text",
					caps: capabilitiesOf("text", false),
					contract: undefined,
					text: ownedTextInfo(info)
				})
			)
		case "closedId": {
			const name = parseDeclaredName(desc.roster)
			const handles = name.ok ? env.roster(name.value) : undefined
			if (!name.ok || handles === undefined) {
				return Result.err(
					malformedDescription(loc, `a closed relation named ${JSON.stringify(desc.roster)}`)
				)
			}
			return Result.ok(
				Object.freeze({
					carrier: "enum",
					caps: capabilitiesOf("enum", false),
					contract: undefined,
					roster: Object.freeze({
						closed: name.value,
						handles: Object.isFrozen(handles) ? handles : Object.freeze(handles)
					})
				})
			)
		}
		case "vector": {
			const dims = desc.dimensions
			return Result.ok(
				Object.freeze({
					carrier: "vector",
					caps: capabilitiesOf("vector", false),
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

/** A plain value type of `carrier`: no typmod, refinement or contract. */
const plainType = (carrier: (typeof pgCarriers)[keyof typeof pgCarriers] | "uuid"): ContractBase =>
	Object.freeze({ carrier, caps: capabilitiesOf(carrier, false), contract: undefined })

const numericType = (typmod: NumericTypmod): ContractBase =>
	Object.freeze({
		carrier: "numeric",
		caps: capabilitiesOf("numeric", false),
		typmod,
		contract: undefined
	})

/**
 * A computed numeric of `bound`, frozen (ir/scalar.ts NumericBound), its keys in the decoder's order: an operation's,
 * an aggregate's or a literal's numeric, which no declaration states.
 */
export const numericValue = (bound: NumericBound): ValueType =>
	Object.freeze({
		carrier: "numeric",
		caps: capabilitiesOf("numeric", false),
		typmod: undefined,
		contract: undefined,
		bound: Object.freeze({ digits: bound.digits, scale: bound.scale })
	})

/**
 * A span over `endpoint`: range4 over integer and range8 over bigint, through contracts, refused with a
 * capability diagnostic for any other endpoint, a serial among them.
 */
export const spanType = (
	endpoint: ScalarType,
	width: bigint | undefined,
	loc: SourceLoc
): Result.Result<Extract<ScalarType, { readonly carrier: SpanCarrier }>, CompileError> => {
	if ("serial" in endpoint || (endpoint.carrier !== "int4" && endpoint.carrier !== "int8")) {
		return Result.err(
			capabilityError(loc, "spanEndpoint", `${typeLabel(endpoint)} ${spanEndpointDetail(endpoint)}`)
		)
	}
	const carrier = endpoint.carrier === "int4" ? "range4" : "range8"
	return Result.ok(
		Object.freeze({
			carrier,
			caps: capabilitiesOf(carrier, false),
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
 * builder, which needs none). A contract over a serial is refused UnsupportedOperation: a serial is a generation
 * declaration, not a value domain.
 *
 * A serial is a generation declaration, not a value domain: no registry capability is missing, so the refusal is
 * an unsupported operation in its own words, never a capability diagnostic.
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

/** The contract `name` over `base` with `predicate`'s table: a contract over a serial is a generation refusal. */
const contractOver = (
	name: DeclaredName,
	base: DeclaredType,
	loc: SourceLoc,
	predicate: ExprTable | undefined,
	facts: ReadonlyArray<Fact>
): Result.Result<ContractInfo, CompileError> => {
	if ("serial" in base) {
		return Result.err(
			unsupported(
				loc,
				`contractBase: ${typeLabel(base)} is a column generation declaration, not a value domain; a contract over its integer type is the domain`
			)
		)
	}
	return Result.ok(Object.freeze({ name, base, predicate, facts }))
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
 * spanEndpoint capability is a capability diagnostic and a contract over a serial a generation refusal (both
 * UnsupportedOperation); an unknown roster, and a contract name the declared-name rule refuses, is MalformedDescription.
 */
export const scalarTypeOf = (
	desc: FieldDesc,
	env: ScalarEnv,
	loc: SourceLoc
): Result.Result<DeclaredType, CompileError> => scalarAt(desc, env, loc)

/**
 * A literal operand for a term of type `t`, as the Description boundary carries it (ir/desc.ts LiteralDesc): the
 * host value of t's base, since a literal compared with or written into a contract term adopts the contract.
 * The host representation is checked here, at construction: a JavaScript number is never a
 * numeric literal, an exact decimal string is parsed into its Decimal, a uuid takes its canonical lowercase spelling,
 * text must be storable, a handle must be in the roster, a vector must have the type's dimensions, and the
 * float specials travel wrapped. Ranges, typmods and refinements are the checker's: a value that is the right kind
 * but does not fit is ContractLiteral or MalformedDescription at compilation. The value is read once through hostRead:
 * reading it can run the caller's code (a proxy's traps, a getter), and a value whose reading throws is refused by its
 * carrier's host-type fault, as admission refuses it (values/identity.ts).
 */
export const literalDescFor = (
	t: ScalarType,
	value: unknown
): Result.Result<LiteralDesc, ValueFault> => {
	const base = baseOf(t)
	return hostRead(unreadableFault[base.carrier], () => hostLiteral(base, value))
}

/**
 * The literal of a base type `base` for the caller's `value`, which literalDescFor reads through hostRead.
 *
 * The Description holds the frozen canonical payload of the buffer's components now (Vector.canonical).
 *
 * A JavaScript integer: a fraction or an unsafe integer is the wrong host kind, as in Compute.
 */
const hostLiteral = (base: ScalarType, value: unknown): Result.Result<LiteralDesc, ValueFault> => {
	switch (base.carrier) {
		case "int2":
		case "int4":
			return isSafeInteger(value) ? Result.ok(value === 0 ? 0 : value) : Result.err("integerType")
		case "int8":
			return typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")
		case "numeric":
			if (typeof value === "number") {
				return Result.err("decimalNumber")
			}
			return Decimal.parse(value)
		case "float4":
		case "float8":
			if (typeof value !== "number") {
				return Result.err("floatType")
			}
			if (Number.isNaN(value)) {
				return Result.ok({ float: "NaN" })
			}
			if (value === Number.POSITIVE_INFINITY) {
				return Result.ok({ float: "Infinity" })
			}
			if (value === Number.NEGATIVE_INFINITY) {
				return Result.ok({ float: "-Infinity" })
			}
			return Result.ok(value === 0 ? 0 : value)
		case "money":
			return value instanceof Money ? Result.ok(value) : Result.err("moneyType")
		case "bool":
			return typeof value === "boolean" ? Result.ok(value) : Result.err("boolType")
		case "uuid":
			return toUuid(value)
		case "text":
			return validateText(value)
		case "enum":
			return typeof value === "string" && base.roster.handles.includes(value)
				? Result.ok(value)
				: Result.err("enumHandle")
		case "range4":
		case "range8": {
			if (!hasProperties(value) || isList(value)) {
				return Result.err("spanType")
			}
			const keys = Object.keys(value)
			if (keys.length !== 2 || !Object.hasOwn(value, "start") || !Object.hasOwn(value, "end")) {
				return Result.err("spanType")
			}
			const { start, end } = value
			const ok = (x: unknown): x is number | bigint =>
				base.carrier === "range4" ? isSafeInteger(x) : typeof x === "bigint"
			if (!ok(start) || !ok(end)) {
				return Result.err("spanEndpoint")
			}
			return Result.ok({ span: { start, end } })
		}
		case "vector":
			return Result.flatMap(Vector.admit(value, base.typmod.dims), Vector.canonical)
		case "exactInteger":
			return typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")
		case "exactMoney":
			return value instanceof Money ? Result.ok(value) : Result.err("moneyType")
	}
}

/** The throwing form, for builders: a literal of the wrong host kind is MalformedDescription naming what was needed. */
export const literalDescOrThrow = (t: ScalarType, value: unknown, label: string): LiteralDesc => {
	const literal = literalDescFor(t, value)
	if (!literal.ok) {
		throw malformedDescription(captureLoc(label, []), describeFault(literal.error))
	}
	return literal.value
}
