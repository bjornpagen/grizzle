import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	Array as Arr,
	Data,
	Effect,
	JsonPointer,
	Option,
	Order,
	Predicate,
	Record,
	Result,
	String as Str,
	pipe
} from "effect"
import { isJsDocText } from "#emit/escape.ts"
import type { JsDocText } from "#emit/escape.ts"
import type { EmittedFile } from "#emit/package.ts"
import {
	arr,
	arrow,
	bool,
	call,
	fixedMemberName,
	fixedModuleSpecifier,
	ident,
	isMemberName,
	member,
	num,
	obj,
	printModule,
	str,
	typeKeyword,
	typeLiteral,
	typeApply,
	typedArrow,
	typeName,
	typeReadonlyArray,
	typeRef,
	typeUnion
} from "#emit/printer.ts"
import type {
	Expr,
	Field,
	Import,
	MemberName,
	Param,
	PrinterError,
	Statement,
	TypeExpr
} from "#emit/printer.ts"
import type {
	Api,
	EncodingRule,
	EventContract,
	MediaAlternative,
	Operation,
	Parameter,
	ResponseCase,
	SecurityScheme,
	Server
} from "#model/entities.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { formatPointer } from "#model/pointer.ts"
import { documentLabel } from "#model/uri.ts"
import { constantOf } from "#names/constant.ts"
import type { ConstantValue } from "#names/constant.ts"
import { isPositionalBody } from "#names/flatten.ts"
import { foldIdentifier, fixedIdentifier, isIdentifier, type Identifier } from "#names/fold.ts"
import type { SafeIdentifier } from "#names/fold.ts"
import type {
	NamePlan,
	PlannedCertificate,
	PlannedCommand,
	PlannedFlag,
	PlannedGroup
} from "#names/index.ts"
import { isBooleanSchema, isPasswordSchema, suffixed } from "#names/plan.ts"
import type { FlagSource, PartOptionKind } from "#names/plan.ts"
import { sendsFormPairs } from "#normalize/bodies.ts"
import { isJsonMedia } from "#runtime-src/runtime/serialize.ts"

/**
 * What the `api/` layer is emitted from: the normalized `Api`, its name plan, and the bound origin
 * set of a servers level (design 6.4: that level's accepted servers' expansions plus the author's
 * `acceptedOrigins`). Each servers table binds the set of its own servers only.
 */
export interface ApiEmitInput {
	readonly api: Api
	readonly boundOrigins: (servers: readonly Server[]) => readonly string[]
	readonly plan: NamePlan
}

/**
 * The plan or model holds something the `api/` layer cannot express. Earlier stages refuse every
 * input that reaches this. A group whose file segment is a fixed module is refused by the names
 * plan first (`TAG-02/reserved-segment`); `reserved-segment` here is a defense-in-depth check.
 */
export class ApiEmitError extends Data.TaggedError("ApiEmitError")<{
	readonly reason:
		| "reserved-segment"
		| "unknown-scheme"
		| "unprintable-name"
		| "unresolved-schema"
		| "unsupported-encoding"
		| "unsupported-parameter"
		| "unsupported-scheme"
	readonly subject: string
}> {}

/**
 * One parameter's key in its operation's `Input` type.
 */
export interface InputKey {
	readonly key: string
	readonly parameter: Parameter
}

const fixedInputKeys: readonly string[] = ["body", "contentType"]

/**
 * Segments of the modules every package has: `api/servers.ts`, `api/security.ts`, the root
 * commands' `api/root.ts` and `cli/root.ts`.
 */
const reservedSegments: ReadonlySet<string> = new Set(["root", "security", "servers"])

/**
 * The `Input` keys of an operation's parameters, in parameter order: the wire name folded to camel
 * case, renamed by numeric suffix on a repeat. `body` and `contentType` are reserved. Keys never
 * depend on flag spelling, so an author-config rename leaves the `api/` layer unchanged.
 */
export const inputKeys = (operation: Operation): readonly InputKey[] => {
	const taken = new Set(fixedInputKeys)

	return Arr.map(operation.parameters, (parameter) => {
		const folded = foldIdentifier(parameter.wireName, "camel")
		const base = Result.isSuccess(folded) ? folded.success.name : "parameter"
		const key = taken.has(base) ? suffixed(base, (candidate) => taken.has(candidate)) : base
		taken.add(key)

		return { key, parameter }
	})
}

const refPrefix = "#/$defs/"

const scalarTypes: ReadonlySet<string> = new Set(["boolean", "integer", "number", "string"])

const own = (record: JsonObject, key: string): Json | undefined =>
	Record.has(record, key) ? record[key] : undefined

const isNode = (json: Json | undefined): json is JsonObject => json !== undefined && isObject(json)

/**
 * The node a schema reaches after its `$ref` chain through the store, or the key that does not
 * resolve; a chain back to a node it has passed is a cycle, which resolves to none, so it ends.
 */
const settle = (
	defs: JsonObject,
	start: Json | undefined,
	subject: string
): Result.Result<JsonObject, string> => {
	const passed = new Set<JsonObject>()
	let current = start
	let key = subject
	while (isNode(current) && !passed.has(current)) {
		passed.add(current)

		const ref = own(current, "$ref")
		if (ref === undefined) {
			return Result.succeed(current)
		}

		if (!Predicate.isString(ref) || !Str.startsWith(refPrefix)(ref)) {
			return Result.fail(key)
		}

		key = JsonPointer.unescapeToken(Str.slice(refPrefix.length)(ref))
		current = own(defs, key)
	}

	return Result.fail(key)
}

/** A settled node's own `type` when it is one of the scalar types. */
const scalarOf = (node: JsonObject): string | undefined => {
	const type = own(node, "type")

	return Predicate.isString(type) && scalarTypes.has(type) ? type : undefined
}

/** Whether a parameter value is given once per item, and its scalar `type`, if it has one. */
interface ScalarValue {
	readonly array: boolean
	readonly type: string | undefined
}

/**
 * How a stored parameter schema's value is given, through its `$ref` chain: whether it is an array,
 * and the scalar `type` of the schema, or of its `items` for an array. A type list, an untyped
 * schema and an array without `items` have no scalar type. The failure is the store key that does
 * not resolve.
 */
const scalarValueOf = (defs: JsonObject, key: string): Result.Result<ScalarValue, string> =>
	Result.flatMap(settle(defs, own(defs, key), key), (node): Result.Result<ScalarValue, string> => {
		if (own(node, "type") !== "array") {
			return Result.succeed({ array: false, type: scalarOf(node) })
		}

		const items = own(node, "items")

		return items === undefined
			? Result.succeed({ array: true, type: undefined })
			: Result.map(settle(defs, items, key), (item) => ({ array: true, type: scalarOf(item) }))
	})

/**
 * Whether a stored parameter schema is `type: "array"` whose `items` is a scalar type (design 6.1):
 * the operator gives such a parameter once per item. An array without `items`, or of objects or
 * arrays, is not one. The failure is the store key that does not resolve.
 */
export const isScalarArraySchema = (
	defs: JsonObject,
	key: string
): Result.Result<boolean, string> =>
	Result.map(scalarValueOf(defs, key), ({ array, type }) => array && type !== undefined)

/**
 * The scalar `type` of a stored parameter schema through its `$ref` chain, or of its `items` for an
 * array (`"boolean"`, `"integer"`, `"number"` or `"string"`). A 3.1 type list, an untyped schema
 * and an array of objects or arrays have none. The failure is the store key that does not resolve.
 */
export const scalarTypeOf = (
	defs: JsonObject,
	key: string
): Result.Result<string | undefined, string> =>
	Result.map(scalarValueOf(defs, key), ({ type }) => type)

const refuse = (reason: ApiEmitError["reason"], subject: string) =>
	new ApiEmitError({ reason, subject })

const identifier = (name: string): Effect.Effect<Identifier, ApiEmitError> =>
	isIdentifier(name) ? Effect.succeed(name) : Effect.fail(refuse("unprintable-name", name))

const memberName = (name: string): Effect.Effect<MemberName, ApiEmitError> =>
	isMemberName(name) ? Effect.succeed(name) : Effect.fail(refuse("unprintable-name", name))

const docText = (text: string): Effect.Effect<JsDocText, ApiEmitError> =>
	isJsDocText(text) ? Effect.succeed(text) : Effect.fail(refuse("unprintable-name", text))

const serialize = ident(fixedIdentifier("Serialize"))

const fn = (name: string, args: readonly Expr[]) =>
	call(member(serialize, fixedMemberName(name)), args)

const strings = (values: readonly string[]) => arr(Arr.map(values, str))

/** The `input` argument's member that holds an `Input` key. */
const inputMember = (key: string): Effect.Effect<Expr, ApiEmitError> =>
	Effect.map(memberName(key), (name) => member(ident(fixedIdentifier("input")), name))

const optionalOf = (type: TypeExpr) => typeUnion([type, typeKeyword("undefined")])

const groupImports: readonly Import[] = [
	{
		_tag: "Named",
		from: fixedModuleSpecifier("../runtime/auth.ts"),
		names: [fixedIdentifier("SecurityRequirement")],
		typeOnly: true
	},
	{
		_tag: "Named",
		from: fixedModuleSpecifier("../runtime/negotiate.ts"),
		names: [fixedIdentifier("MediaDeclaration")],
		typeOnly: true
	},
	{
		_tag: "Namespace",
		from: fixedModuleSpecifier("../runtime/serialize.ts"),
		name: fixedIdentifier("Serialize"),
		typeOnly: false
	}
]

/**
 * The import of a module whose operations' metas hold an event table.
 */
const eventTableImport: Import = {
	_tag: "Named",
	from: fixedModuleSpecifier("../runtime/sse.ts"),
	names: [fixedIdentifier("EventTable")],
	typeOnly: true
}

const essence = (mediaType: string): string =>
	Str.toLowerCase(Str.trim(Arr.headNonEmpty(Str.split(";")(mediaType))))

const isRange = (mediaType: string): boolean => Str.endsWith("/*")(essence(mediaType))

const mediaTypes = (alternatives: readonly MediaAlternative[]) =>
	Arr.map(alternatives, (alternative) => alternative.mediaType)

const refusedFieldsOf = (alternative: MediaAlternative): readonly string[] =>
	alternative.refusedFields ?? []

/**
 * The `refused` entry of an operation's media declaration: each request key with refused fields,
 * in alternative order (design 8.5 rule 6). `None` when no alternative refuses one, so a spec
 * without a field refusal emits what it emitted before.
 */
const refusedEntry = (alternatives: readonly MediaAlternative[]): Option.Option<Expr> => {
	const listed = Arr.filter(alternatives, (alternative) => refusedFieldsOf(alternative).length > 0)

	return listed.length === 0
		? Option.none()
		: Option.some(
				obj(
					Arr.map(listed, (alternative) => [
						alternative.mediaType,
						strings(refusedFieldsOf(alternative))
					])
				)
			)
}

/** The domain module's namespace in an api module whose event rows check their data against its schemas. */
const domainNamespace = fixedIdentifier("Domain")

/**
 * How an event row's data reads, as the runtime's `EventData` holds it: `text` or `json`, or `{ json }` holding the
 * domain module's schema of its `contentSchema`, which the runtime checks the data against.
 */
const eventDataExpr = (
	data: EventContract["events"][number]["data"],
	domain: ReadonlyMap<string, SafeIdentifier>
): Effect.Effect<Expr, ApiEmitError> => {
	if (typeof data === "string") {
		return Effect.succeed(str(data))
	}

	const name = domain.get(data.json)

	return name === undefined
		? Effect.fail(refuse("unresolved-schema", data.json))
		: Effect.succeed(obj([["json", member(ident(domainNamespace), fixedMemberName(name))]]))
}

/**
 * One event row of a contract as the runtime's `EventRow` holds it: its data, its retry rule or the one event that
 * follows it when it has one, its role.
 */
const eventRowExpr = (event: EventContract["events"][number], data: Expr): Expr =>
	obj([
		["data", data],
		...("retryWhen" in event
			? ([
					[
						"retryWhen",
						obj([
							[
								"equals",
								typeof event.retryWhen.equals === "string"
									? str(event.retryWhen.equals)
									: typeof event.retryWhen.equals === "number"
										? num(event.retryWhen.equals)
										: bool(event.retryWhen.equals)
							],
							["pointer", str(event.retryWhen.pointer)]
						])
					]
				] as const)
			: []),
		...("next" in event ? ([["next", str(event.next)]] as const) : []),
		["role", str(event.role)]
	])

/**
 * An event contract as the runtime's `EventContract` holds it: its rows by event name, and what other events are.
 */
const eventContractExpr = (
	contract: EventContract,
	domain: ReadonlyMap<string, SafeIdentifier>
): Effect.Effect<Expr, ApiEmitError> =>
	Effect.map(
		Effect.forEach(contract.events, (event) =>
			Effect.map(
				eventDataExpr(event.data, domain),
				(data) => [event.name, eventRowExpr(event, data)] as const
			)
		),
		(rows) => contractExpr(contract, rows)
	)

const contractExpr = (
	contract: EventContract,
	rows: ReadonlyArray<readonly [string, Expr]>
): Expr =>
	obj([
		["events", obj(rows)],
		[
			"otherwise",
			contract.otherwise._tag === "Closed"
				? obj([["_tag", str("Closed")]])
				: obj([
						["_tag", str("Open")],
						["data", str(contract.otherwise.data)]
					])
		]
	])

/**
 * The operation's event table (`EventTable`): the contract of each response alternative that carries one, by response
 * key and then media key; empty when none does.
 */
const eventTableOf = (
	responses: Operation["responses"],
	domain: ReadonlyMap<string, SafeIdentifier>
): Effect.Effect<ReadonlyArray<readonly [string, Expr]>, ApiEmitError> =>
	Effect.map(
		Effect.forEach(responses, (response) =>
			Effect.map(
				Effect.forEach(
					Arr.flatMap(response.alternatives, (alternative) =>
						alternative.events === undefined
							? []
							: [[alternative.mediaType, alternative.events] as const]
					),
					([mediaType, events]) =>
						Effect.map(
							eventContractExpr(events, domain),
							(contract) => [mediaType, contract] as const
						)
				),
				(byMedia): ReadonlyArray<readonly [string, Expr]> =>
					byMedia.length === 0 ? [] : [[responseKey(response.key), obj(byMedia)]]
			)
		),
		Arr.flatten
	)

/** The event contracts an operation's responses carry. */
const contractsOf = (operation: Operation): ReadonlyArray<EventContract> =>
	Arr.flatMap(operation.responses, (response) =>
		Arr.flatMap(response.alternatives, (alternative) =>
			alternative.events === undefined ? [] : [alternative.events]
		)
	)

/**
 * Whether an operation's emitted meta holds an event table.
 */
const hasEventTable = (operation: Operation): boolean => contractsOf(operation).length > 0

/** Whether an operation's event table checks some event's data against a domain schema. */
const checksEventData = (operation: Operation): boolean =>
	Arr.some(contractsOf(operation), (contract) =>
		Arr.some(contract.events, (event) => typeof event.data !== "string")
	)

/** The import of the domain module, as `Domain`, by a module whose event rows check their data. */
const domainImport: Import = {
	_tag: "Namespace",
	from: fixedModuleSpecifier("../domain/schemas.ts"),
	name: domainNamespace,
	typeOnly: false
}

const responseKey = (key: ResponseCase["key"]): string => {
	if (key === "default") {
		return key
	}

	return "code" in key ? String(key.code) : `${key.range}XX`
}

/**
 * The bracket convention option, `brackets: true`, for an entry the model marks (design 6.1);
 * nothing for an unmarked one, so it emits what it emitted before (C16).
 */
const brackets = (marker: EncodingRule["nonStandard"]): readonly (readonly [string, Expr])[] =>
	marker === "deepObjectBrackets" ? [["brackets", bool(true)]] : []

/**
 * The scalar switch's option, `scalars: true`, for an entry the model marks (design 6.1 Scalar
 * switch); nothing for an unmarked one (C16).
 */
const scalars = (
	marker: EncodingRule["nonStandardScalars"]
): readonly (readonly [string, Expr])[] =>
	marker === "deepObjectScalars" ? [["scalars", bool(true)]] : []

/**
 * The list of the request a parameter's serializer call joins: its location's, and `query` for a
 * `querystring` parameter.
 */
type ParameterList = "cookies" | "headers" | "path" | "query"

/**
 * What one parameter adds to its operation's builder: the input field it reads, none for a
 * constant, and the serializer call of its location, in the list it joins.
 */
interface ParameterParts {
	readonly call: Expr
	readonly field: Option.Option<Field>
	readonly list: ParameterList
}

const pathStyles: ReadonlySet<string> = new Set(["label", "matrix", "simple"])

const queryStyles: ReadonlySet<string> = new Set([
	"deepObject",
	"form",
	"pipeDelimited",
	"spaceDelimited"
])

interface ObjectSchemas {
	readonly properties: ReadonlyMap<string, Json>
	readonly required: ReadonlySet<string>
}

/**
 * The nodes of a stored schema and of its `allOf` members, each settled through its `$ref` chain:
 * its own, then its members', in document order, each node read once. A member that does not
 * resolve has none.
 */
const allOfNodes = (defs: JsonObject, key: string): readonly JsonObject[] => {
	const nodes: JsonObject[] = []
	const seen = new Set<JsonObject>()
	const pending: (Json | undefined)[] = [own(defs, key)]
	while (pending.length > 0) {
		const node = settle(defs, pending.pop(), key)
		if (Result.isFailure(node) || seen.has(node.success)) {
			continue
		}

		seen.add(node.success)
		nodes.push(node.success)

		const members = own(node.success, "allOf")
		const listed = members !== undefined && isArray(members) ? Arr.filter(members, isNode) : []
		for (const next of Arr.reverse(listed)) {
			pending.push(next)
		}
	}

	return nodes
}

/** The `allOf` nodes of a body alternative's schema (`allOfNodes`); none when it has no schema. */
const bodyNodes = (defs: JsonObject, alternative: MediaAlternative): readonly JsonObject[] =>
	alternative.schema === undefined ? [] : allOfNodes(defs, alternative.schema.key)

/**
 * The properties and `required` names of an object root (a multipart or form body, a form
 * querystring) from its `allOf` nodes: its own, then those of its `allOf` members, in document
 * order.
 */
const objectSchemas = (nodes: readonly JsonObject[]): ObjectSchemas => {
	const properties = new Map<string, Json>()
	const required = new Set<string>()
	for (const node of nodes) {
		const declared = own(node, "properties")
		for (const [name, schema] of isNode(declared) ? Record.toEntries(declared) : []) {
			properties.getOrInsert(name, schema)
		}

		const names = own(node, "required")
		for (const name of Arr.isArray(names) ? Arr.filter(names, Predicate.isString) : []) {
			required.add(name)
		}
	}

	return { properties, required }
}

const cookieStyles: ReadonlySet<string> = new Set(["cookie", "form"])

const headerStyles: ReadonlySet<string> = new Set(["simple"])

/** The styles each location's builder writes; a `querystring` parameter is written by content. */
const locationStyles: Readonly<
	Record<Exclude<Parameter["location"], "querystring">, ReadonlySet<string>>
> = { cookie: cookieStyles, header: headerStyles, path: pathStyles, query: queryStyles }

const formMedia = "application/x-www-form-urlencoded"

/**
 * The constructor that writes a `content` parameter in each location that takes one (PRM-15), and
 * the list its call joins.
 */
const contentConstructors: Readonly<
	Partial<Record<Parameter["location"], { readonly list: ParameterList; readonly writer: string }>>
> = {
	cookie: { list: "cookies", writer: "cookieContent" },
	header: { list: "headers", writer: "headerContent" },
	query: { list: "query", writer: "queryContent" }
}

/**
 * Whether the `api/` layer builds a parameter: a `querystring` parameter in `content` form, a
 * query, header or cookie parameter in `content` form under any media but form-urlencoded, or any
 * other in a style its location takes. An operation with any other parameter (path content among
 * them) gets no builder, and `emitCli` refuses it alone (`unsupported-parameter`).
 */
export const buildsParameter = (parameter: Parameter): boolean => {
	const { location, serialization } = parameter
	if (serialization.kind === "content") {
		return (
			location === "querystring" ||
			(contentConstructors[location] !== undefined &&
				essence(serialization.mediaType) !== formMedia)
		)
	}

	return location !== "querystring" && locationStyles[location].has(serialization.style)
}

/**
 * Whether a `content` parameter's value is JSON data: under JSON media, which the runtime writes as
 * compact JSON text, and under form media in `querystring`, whose object the runtime writes as
 * pairs. Under any other media the value is the operator's string, sent as given.
 */
export const takesJsonContent = (location: Parameter["location"], mediaType: string): boolean =>
	isJsonMedia(mediaType) || (location === "querystring" && essence(mediaType) === formMedia)

interface ParameterContext {
	readonly defs: JsonObject
	readonly line: Api["line"]
	readonly memo: Map<string, boolean>
}

/** The type of a JSON value the runtime serializes, `Serialize.Json`. */
const jsonType = typeRef(fixedIdentifier("Serialize"), [fixedMemberName("Json")])

/** A parameter's field in its operation's `Input` type, optional when the parameter is. */
const parameterField = (key: string, parameter: Parameter, type: TypeExpr): Field => ({
	key,
	optional: !parameter.required,
	type: parameter.required ? type : optionalOf(type)
})

/**
 * A `querystring` parameter (design 6.1): its value is JSON data the runtime serializes by its one
 * media type. Form content declares the object's properties in document order, each with the
 * Encoding Object fields of its rule, as a form body's properties are (design 6.3).
 */
const querystringParts = (
	entry: InputKey,
	defs: JsonObject
): Effect.Effect<ParameterParts, ApiEmitError> =>
	Effect.gen(function* parts() {
		const { key, parameter } = entry
		const { serialization } = parameter
		if (serialization.kind !== "content") {
			return yield* refuse("unsupported-parameter", `querystring:${parameter.wireName}`)
		}

		const { mediaType } = serialization
		const options: (readonly [string, Expr])[] = [["required", bool(parameter.required)]]
		if (essence(mediaType) === formMedia) {
			const properties = yield* formProperties(
				serialization,
				allOfNodes(defs, serialization.schema.key)
			)
			options.push(["properties", properties])
		}

		const value = yield* inputMember(key)

		return {
			call: fn("querystring", [str(parameter.wireName), str(mediaType), value, obj(options)]),
			field: Option.some(parameterField(key, parameter, jsonType)),
			list: "query"
		}
	})

/**
 * A query, header or cookie `content` parameter (design 6.1): JSON data the runtime serializes by
 * its one media type, through the location's content constructor.
 */
const contentParts = (entry: InputKey): Effect.Effect<ParameterParts, ApiEmitError> =>
	Effect.gen(function* parts() {
		const { key, parameter } = entry
		const { location, serialization } = parameter
		const constructor = contentConstructors[location]
		if (serialization.kind !== "content" || constructor === undefined) {
			return yield* refuse("unsupported-parameter", `${location}:${parameter.wireName}`)
		}

		const value = yield* inputMember(key)

		return {
			call: fn(constructor.writer, [
				str(parameter.wireName),
				str(serialization.mediaType),
				value,
				obj([["required", bool(parameter.required)]])
			]),
			field: Option.some(parameterField(key, parameter, jsonType)),
			list: constructor.list
		}
	})

/**
 * A constant parameter's value as the builder passes it: a boolean as itself, any other value as
 * the text the operator would have typed.
 */
const constantExpr = (value: ConstantValue): Expr =>
	typeof value === "boolean" ? bool(value) : str(typeof value === "number" ? String(value) : value)

/**
 * What one parameter adds to its operation's builder: a `querystring` or `content` parameter's
 * parts are its own builder's, and any other's are its style's, as its location's serializer
 * writes them. An object's value is JSON data, as a `content` parameter's is; the runtime refuses a
 * member that is itself an object or array. A scalar-marked union is one JSON value too (design 6.1
 * Scalar switch).
 */
const parameterParts = (
	entry: InputKey,
	context: ParameterContext
): Effect.Effect<ParameterParts, ApiEmitError> =>
	Effect.gen(function* parts() {
		const { defs, memo } = context
		const { key, parameter } = entry
		const { serialization } = parameter
		const subject = `${parameter.location}:${parameter.wireName}`
		if (!buildsParameter(parameter)) {
			return yield* refuse("unsupported-parameter", subject)
		}

		if (parameter.location === "querystring") {
			return yield* querystringParts(entry, defs)
		}

		if (serialization.kind === "content") {
			return yield* contentParts(entry)
		}

		const boolean = isBooleanSchema(defs, memo, parameter.schema.key)
		if (Result.isFailure(boolean)) {
			return yield* refuse("unresolved-schema", boolean.failure.key)
		}

		const array = isScalarArraySchema(defs, parameter.schema.key)
		if (Result.isFailure(array)) {
			return yield* refuse("unresolved-schema", array.failure)
		}

		const scalarType = array.success
			? typeReadonlyArray(typeKeyword("string"))
			: typeKeyword(boolean.success ? "boolean" : "string")
		const valueType =
			serialization.objectValued || serialization.nonStandardScalars !== undefined
				? jsonType
				: scalarType
		const constant = constantOf(defs, parameter)
		const field: Option.Option<Field> = Option.isSome(constant)
			? Option.none()
			: Option.some(parameterField(key, parameter, valueType))
		const value = Option.isSome(constant) ? constantExpr(constant.value) : yield* inputMember(key)
		const { allowReserved, explode, style } = serialization
		const wire = str(parameter.wireName)
		const required = bool(parameter.required)
		if (parameter.location === "path") {
			const options = obj([
				["allowReserved", bool(allowReserved)],
				["explode", bool(explode)]
			])

			return { call: fn(style, [wire, value, options]), field, list: "path" }
		}

		if (parameter.location === "query") {
			const options = obj([
				["allowReserved", bool(allowReserved)],
				...brackets(serialization.nonStandard),
				["explode", bool(explode)],
				["required", required],
				...scalars(serialization.nonStandardScalars)
			])

			return { call: fn(style, [wire, value, options]), field, list: "query" }
		}

		if (parameter.location === "header") {
			const options = obj([
				["explode", bool(explode)],
				["required", required]
			])

			return { call: fn("header", [wire, value, options]), field, list: "headers" }
		}

		const options = obj([
			["allowReserved", bool(allowReserved)],
			["explode", bool(explode)],
			["line", str(context.line)],
			["required", required],
			["style", str(style)]
		])

		return { call: fn("cookie", [wire, value, options]), field, list: "cookies" }
	})

/**
 * A part's `Content-Type`: the one media type its Encoding `contentType` lists, or the operator's
 * choice among several (design 6.3, ENC-10), with the listed types and the `--<part>-content-type`
 * flag.
 */
export type PartType =
	| { readonly _tag: "Declared"; readonly mediaType: string }
	| {
			readonly _tag: "Chosen"
			readonly choices: readonly string[]
			readonly flag: PlannedFlag
	  }

/**
 * One declared header of a part (ENC-03, HDR-01) and its `--<part>-<header>` flag.
 */
export interface PartHeader {
	readonly flag: PlannedFlag
	readonly header: EncodingRule["headers"][number]
}

/**
 * One nested part of a by-name nested part (design 6.3, HT:B16, ENC-07): its dotted part flag, its
 * nested name and the one `Content-Type` its nested rule gives.
 */
export interface NestedFormPart {
	readonly contentType: string
	readonly flag: PlannedFlag
	readonly name: string
}

/**
 * The nested body of a part by name: its kind, from the part's Encoding `contentType`, and its
 * nested parts in nested property order.
 */
export interface NestedParts {
	readonly kind: "form-data" | "mixed"
	readonly parts: readonly NestedFormPart[]
}

/**
 * The nested body of a part by position (design 6.3, HT:B16, ENC-08, ENC-09): one
 * `multipart/mixed` nested part from the part's repeated file flag, file `i` under
 * `positions[i]` and every later file under `item`.
 */
export interface NestedPositions {
	readonly item?: string
	readonly positions: readonly string[]
}

/**
 * One `multipart/form-data` part a command sends: its part flag, its part name, its `Content-Type`,
 * its declared headers and, from its Encoding rule, its transfer encoding. `key` is the part's key
 * in the builder's form when the part travels as a `Serialize.ChosenPart` beside `fields`: it
 * lists several types or declares a header. A part with `nested` is sent as one nested part from
 * its nested parts' flags; its `flag` is the first of them. A part with `positions` is sent as one
 * nested part from its own repeated file flag.
 */
export interface FormPart {
	readonly contentEncoding?: "base64"
	readonly contentType: PartType
	readonly flag: PlannedFlag
	readonly headers: readonly PartHeader[]
	readonly key?: string
	readonly name: string
	readonly nested?: NestedParts
	readonly positions?: NestedPositions
}

/**
 * The keys in the builder's form of the parts that travel as a `Serialize.ChosenPart` (ENC-10,
 * ENC-03), by part name: each multipart part whose Encoding `contentType` lists several types or
 * whose rule declares a header, folded to camel case and renamed by numeric suffix past `fields`
 * and each other. Keys never depend on flag spelling.
 */
const keyedPartKeys = (operation: Operation): ReadonlyMap<string, string> => {
	const taken = new Set(["fields"])
	const keys = new Map<string, string>()
	for (const alternative of operation.body?.alternatives ?? []) {
		for (const { contentType, headers, target } of alternative.encoding) {
			if (
				alternative.codec !== "multipart" ||
				target.kind !== "property" ||
				(contentType.length < 2 && headers.length === 0) ||
				keys.has(target.name)
			) {
				continue
			}

			const folded = foldIdentifier(target.name, "camel")
			const base = Result.isSuccess(folded) ? folded.success.name : "part"
			const key = taken.has(base) ? suffixed(base, (candidate) => taken.has(candidate)) : base
			taken.add(key)
			keys.set(target.name, key)
		}
	}

	return keys
}

type PartFlag = PlannedFlag & { readonly source: Extract<FlagSource, { readonly _tag: "Body" }> }

const isPartFlag = (flag: PlannedFlag, mediaType: string): flag is PartFlag =>
	flag.source._tag === "Body" &&
	flag.source.kind !== "body" &&
	flag.source.kind !== "body-file" &&
	flag.source.media.includes(mediaType)

interface OrderedPart extends FormPart {
	readonly order: number
}

/** A nested part with its index among its part's nested rules. */
interface NestedMember {
	readonly order: number
	readonly part: NestedFormPart
}

/** A part flag of a part nested by name, with the nested name its pointer's second token gives. */
interface NestedFlag {
	readonly flag: PartFlag
	readonly nestedName: string
}

interface PartContext {
	readonly alternative: MediaAlternative
	readonly flags: readonly PlannedFlag[]
	readonly keys: ReadonlyMap<string, string>
	readonly schemas: ObjectSchemas
}

/** The unescaped tokens of a part flag's JSON Pointer: the part's name, then a nested part's. */
const pointerTokens = (pointer: string): readonly string[] =>
	Arr.map(Arr.drop(Str.split("/")(pointer), 1), JsonPointer.unescapeToken)

/** The first of a part's rules that encodes the property `name`, with its index among them. */
const ruleNamed = <Rule extends { readonly target: EncodingRule["target"] }>(
	rules: readonly Rule[],
	name: string
): Option.Option<[Rule, number]> =>
	Arr.findFirstWithIndex(
		rules,
		(rule) => rule.target.kind === "property" && rule.target.name === name
	)

/**
 * The part option flag of kind `kind` (and header `header`) of the part at `pointer` under the
 * context's alternative.
 */
const optionFlag = (
	context: PartContext,
	pointer: string,
	matches: (option: PartOptionKind) => boolean
): Option.Option<PlannedFlag> =>
	Arr.findFirst(
		context.flags,
		({ source }) =>
			source._tag === "PartOption" &&
			source.part === pointer &&
			matches(source.option) &&
			source.media.includes(context.alternative.mediaType)
	)

/** The flag that chooses a part's `Content-Type` among `choices` under the context's alternative. */
const choiceOf = (
	context: PartContext,
	pointer: string,
	choices: readonly string[]
): Option.Option<PartType> =>
	Option.map(
		optionFlag(context, pointer, (option) => option.kind === "content-type"),
		(flag): PartType => ({ _tag: "Chosen", choices, flag })
	)

/** Each declared header of a part with its `--<part>-<header>` flag, or the first header with none. */
const headersOf = (
	context: PartContext,
	pointer: string,
	rule: EncodingRule
): Result.Result<readonly PartHeader[], string> => {
	const headers: PartHeader[] = []
	for (const header of rule.headers) {
		const flag = optionFlag(
			context,
			pointer,
			(option) => option.kind === "header" && option.name === header.name
		)
		if (Option.isNone(flag)) {
			return Result.fail(`a flag for header ${header.name} of multipart part ${pointer}`)
		}

		headers.push({ flag: flag.value, header })
	}

	return Result.succeed(headers)
}

/** The reason a body's multipart alternative is not one the writer sends, if it is not. */
const alternativeProblem = (alternative: MediaAlternative): Option.Option<string> => {
	const { mediaType } = alternative
	if (isRange(mediaType) || essence(mediaType) !== "multipart/form-data") {
		return Option.some(`a ${mediaType} request body`)
	}

	const positional =
		alternative.itemSchema !== undefined ||
		alternative.itemEncoding !== undefined ||
		alternative.prefixEncoding.length > 0 ||
		Arr.some(alternative.encoding, (rule) => rule.target.kind === "position")

	return positional ? Option.some(`positional parts of ${mediaType}`) : Option.none()
}

/** The kind of nested body a part's one Encoding `contentType` names, if the writer nests it. */
const nestedKind = (contentType: readonly string[]): NestedParts["kind"] | undefined => {
	const [only, ...more] = contentType
	const named = only === undefined || more.length > 0 ? undefined : essence(only)
	if (named === "multipart/mixed") {
		return "mixed"
	}

	return named === "multipart/form-data" ? "form-data" : undefined
}

type NestedRule = NonNullable<EncodingRule["nested"]>[number]

/**
 * The one concrete type a nested rule gives its nested part, or the reason the writer cannot send
 * it: a nested part has no part headers, no style but exploded `form`, and one listed type.
 */
const nestedType = (rule: NestedRule, subject: string): Result.Result<string, string> => {
	if (rule.headers.length > 0) {
		return Result.fail(`part headers of ${subject}`)
	}

	if (rule.serialization !== undefined && !sendsFormPairs(rule.serialization)) {
		return Result.fail(`a style for ${subject}`)
	}

	const [only, ...more] = rule.contentType
	if (only === undefined || more.length > 0 || Str.includes("*")(only)) {
		return Result.fail(`one content type for ${subject}`)
	}

	return Result.succeed(only)
}

/** Whether a part's rule nests by position: a nested `prefixEncoding` or `itemEncoding`. */
const nestsByPosition = (rule: EncodingRule): boolean =>
	rule.nestedItem !== undefined ||
	Arr.some(rule.nested ?? [], (nested) => nested.target.kind === "position")

/**
 * A part nested by position (design 6.3, HT:B16, ENC-08, ENC-09): its Encoding `contentType` is one
 * `multipart/mixed`, whose parts need no name (form-data would), it declares no part header or
 * transfer encoding and does not also nest by name, and each nested position rule gives one
 * concrete type. Its flag is the part's repeated file flag. Refused otherwise.
 */
const positionalPartOf = (
	flag: PartFlag,
	name: string,
	rule: EncodingRule,
	order: number
): Result.Result<OrderedPart, string> => {
	const pointer = flag.source.wireName
	const kind = nestedKind(rule.contentType)
	const [contentType] = rule.contentType
	if (kind !== "mixed" || contentType === undefined) {
		return Result.fail(`nested parts by position in multipart part ${pointer}`)
	}

	if (rule.headers.length > 0 || rule.contentEncoding !== undefined) {
		return Result.fail(`part headers of multipart part ${pointer}, which nests parts`)
	}

	const nested = rule.nested ?? []
	if (Arr.some(nested, (candidate) => candidate.target.kind === "property")) {
		return Result.fail(`nested parts by name and by position in multipart part ${pointer}`)
	}

	const positions: string[] = []
	for (const [index, position] of nested.entries()) {
		const type = nestedType(position, `nested position ${index + 1} of multipart part ${pointer}`)
		if (Result.isFailure(type)) {
			return Result.fail(type.failure)
		}

		positions.push(type.success)
	}

	const item =
		rule.nestedItem === undefined
			? undefined
			: nestedType(rule.nestedItem, `the nested items of multipart part ${pointer}`)
	if (item !== undefined && Result.isFailure(item)) {
		return Result.fail(item.failure)
	}

	return Result.succeed({
		contentType: { _tag: "Declared", mediaType: contentType },
		flag,
		headers: [],
		name,
		order,
		positions: item === undefined ? { positions } : { item: item.success, positions }
	})
}

/**
 * One part flag's part, the part `name`, with the index of its Encoding rule, or the reason it is
 * refused. A part nested by name is an object part whose nested parts have the flags
 * (`nestedPartOf`). A style the writer sends (ENC-40) arrives typed `text/plain`; normalize refuses
 * any other, and the names plan gives that part no flag.
 */
const partOf = (
	flag: PartFlag,
	name: string,
	context: PartContext
): Result.Result<OrderedPart, string> => {
	const pointer = flag.source.wireName
	const found = ruleNamed(context.alternative.encoding, name)
	if (Option.isNone(found)) {
		return Result.fail(`an encoding for multipart part ${pointer}`)
	}

	const [rule, order] = found.value
	if (nestsByPosition(rule)) {
		return positionalPartOf(flag, name, rule, order)
	}

	if (rule.nested !== undefined) {
		return Result.fail(`nested parts in multipart part ${pointer}`)
	}

	if (rule.serialization !== undefined && !sendsFormPairs(rule.serialization)) {
		return Result.fail(`a style for multipart part ${pointer}`)
	}

	const [first] = rule.contentType
	if (first === undefined || Arr.some(rule.contentType, Str.includes("*"))) {
		return Result.fail(`one content type for multipart part ${pointer}`)
	}

	const contentType =
		rule.contentType.length === 1
			? Option.some<PartType>({ _tag: "Declared", mediaType: first })
			: choiceOf(context, pointer, rule.contentType)
	if (Option.isNone(contentType)) {
		return Result.fail(`a content type flag for multipart part ${pointer}`)
	}

	const headers = headersOf(context, pointer, rule)
	if (Result.isFailure(headers)) {
		return Result.fail(headers.failure)
	}

	const key = context.keys.get(name)
	const keyed = contentType.value._tag === "Chosen" || headers.success.length > 0
	if (keyed && key === undefined) {
		return Result.fail(`a form key for multipart part ${pointer}`)
	}

	return Result.succeed({
		contentType: contentType.value,
		flag,
		headers: headers.success,
		name,
		order,
		...(keyed && key !== undefined ? { key } : {}),
		...(rule.contentEncoding === undefined ? {} : { contentEncoding: rule.contentEncoding })
	})
}

const byOrder = Order.mapInput(Order.Number, (entry: { readonly order: number }) => entry.order)

/**
 * One nested part's flag with its nested name and the one concrete type its nested rule gives, and
 * its index among the nested rules, or the reason the writer cannot send it.
 */
const nestedMemberOf = (
	nestedFlag: NestedFlag,
	rules: readonly NestedRule[]
): Result.Result<NestedMember, string> => {
	const { flag, nestedName } = nestedFlag
	const pointer = flag.source.wireName
	const found = ruleNamed(rules, nestedName)
	if (Option.isNone(found)) {
		return Result.fail(`an encoding for nested multipart part ${pointer}`)
	}

	const [rule, order] = found.value

	return Result.map(nestedType(rule, `nested multipart part ${pointer}`), (contentType) => ({
		order,
		part: { contentType, flag, name: nestedName }
	}))
}

/**
 * A part nested by name (design 6.3, HT:B16, ENC-07): its Encoding `contentType` is one
 * `multipart/mixed` or `multipart/form-data`, it declares no part header or transfer encoding, and
 * each nested part with a flag has one concrete type and no part header. Refused otherwise. Its
 * flag is the first of its nested parts' flags in nested rule order.
 */
const nestedPartOf = (
	name: string,
	members: Arr.NonEmptyReadonlyArray<NestedFlag>,
	context: PartContext
): Result.Result<OrderedPart, string> => {
	const pointer = formatPointer([name])
	const found = Option.flatMap(ruleNamed(context.alternative.encoding, name), ([rule, order]) =>
		rule.nested === undefined ? Option.none() : Option.some({ nested: rule.nested, order, rule })
	)
	if (Option.isNone(found)) {
		return Result.fail(`an encoding for nested multipart part ${pointer}`)
	}

	const { nested, order, rule } = found.value
	const kind = nestedKind(rule.contentType)
	const [contentType] = rule.contentType
	if (kind === undefined || contentType === undefined) {
		return Result.fail(`nested parts in multipart part ${pointer}`)
	}

	if (rule.headers.length > 0 || rule.contentEncoding !== undefined) {
		return Result.fail(`part headers of multipart part ${pointer}, which nests parts`)
	}

	const built = Result.all(Arr.map(members, (entry) => nestedMemberOf(entry, nested)))
	if (Result.isFailure(built)) {
		return Result.fail(built.failure)
	}

	const parts = Arr.map(Arr.sort(built.success, byOrder), ({ part }) => part)

	return Result.succeed({
		contentType: { _tag: "Declared", mediaType: contentType },
		flag: Arr.headNonEmpty(parts).flag,
		headers: [],
		name,
		nested: { kind, parts },
		order
	})
}

/**
 * The parts a `multipart/form-data` command sends, in Encoding order, or the reason the runtime
 * writer cannot send it exactly (design 6.3; a `CliRefusal` subject). `alternative` is one of the
 * command's request media alternatives; the part flags are those whose media lists it. A part
 * nested by name is one nested part from its dotted part flags (HT:B16, ENC-07), and a part nested
 * by position one `multipart/mixed` nested part from its repeated file flag (ENC-08, ENC-09).
 * Refused, not guessed: a multipart alternative under a range key, another multipart subtype, 3.2
 * positional parts, a nested part under any other `contentType` or with part headers, a part nested
 * both by name and by position, a part style other than exploded `form`, a part whose `contentType`
 * lists a range, a part listing several types with no `--<part>-content-type` flag, a part header
 * the names plan gave no `--<part>-<header>` flag, and a required part the names plan gave no flag.
 * Normalize keeps the headers the writer owns out of the rule (ENC-03).
 */
export const formParts = (
	command: PlannedCommand,
	alternative: MediaAlternative,
	defs: JsonObject
): Result.Result<readonly FormPart[], string> => {
	const problem = alternativeProblem(alternative)
	if (Option.isSome(problem)) {
		return Result.fail(problem.value)
	}

	const context: PartContext = {
		alternative,
		flags: command.flags,
		keys: keyedPartKeys(command.operation),
		schemas: objectSchemas(bodyNodes(defs, alternative))
	}
	const parts: OrderedPart[] = []
	const nested = new Map<string, Arr.NonEmptyReadonlyArray<NestedFlag>>()
	for (const flag of command.flags) {
		if (!isPartFlag(flag, alternative.mediaType)) {
			continue
		}

		const [name, nestedName, ...rest] = pointerTokens(flag.source.wireName)
		if (name === undefined || rest.length > 0) {
			return Result.fail(`the nested multipart part ${flag.source.wireName}`)
		}

		if (nestedName !== undefined) {
			const entry: NestedFlag = { flag, nestedName }
			const prior = nested.get(name)
			nested.set(name, prior === undefined ? [entry] : Arr.append(prior, entry))
			continue
		}

		const part = partOf(flag, name, context)
		if (Result.isFailure(part)) {
			return Result.fail(part.failure)
		}

		parts.push(part.success)
	}

	for (const [name, members] of nested) {
		const part = nestedPartOf(name, members, context)
		if (Result.isFailure(part)) {
			return Result.fail(part.failure)
		}

		parts.push(part.success)
	}

	const sent = new Set(Arr.map(parts, (part) => part.name))
	const missing = Arr.findFirst(context.schemas.required, (name) => !sent.has(name))
	if (Option.isSome(missing)) {
		return Result.fail(`a flag for multipart part ${formatPointer([missing.value])}`)
	}

	return Result.succeed(Arr.map(Arr.sort(parts, byOrder), ({ order: _order, ...part }) => part))
}

/**
 * One position rule of a positional body as the writer takes it: one concrete content type and,
 * when the part is sent base64 encoded, its transfer encoding.
 */
export interface PositionRule {
	readonly contentEncoding?: "base64"
	readonly contentType: string
}

/**
 * A positional `multipart/mixed` body's rules (design 6.3, HT:B15): `prefix[i]` for part `i`,
 * `item` for every later part, and the schema's bounds on the part count.
 */
export interface MixedPlan {
	readonly item?: PositionRule
	readonly maxParts?: number
	readonly minParts?: number
	readonly prefix: readonly PositionRule[]
}

/**
 * One position rule the writer sends exactly, or the reason it does not: a rule that does not nest,
 * giving the one concrete type a nested rule would (`nestedType`), whose part headers are named
 * before its nesting.
 */
const positionRule = (rule: EncodingRule, index: number): Result.Result<PositionRule, string> => {
	const at = `positional part ${index + 1}`
	if (rule.nested !== undefined && rule.headers.length === 0) {
		return Result.fail(`nested parts in ${at}`)
	}

	return Result.map(nestedType(rule, at), (contentType) =>
		rule.contentEncoding === undefined
			? { contentType }
			: { contentEncoding: rule.contentEncoding, contentType }
	)
}

/**
 * The part count bounds of a positional body's array schema, from its `allOf` nodes: the tightest
 * `minItems` and `maxItems`, and `items: false`, which admits no part beyond `prefixItems`.
 */
const partBounds = (nodes: readonly JsonObject[]): Pick<MixedPlan, "maxParts" | "minParts"> => {
	const maxima = Arr.flatMap(nodes, ({ items, maxItems, prefixItems }) => [
		...(Predicate.isNumber(maxItems) ? [maxItems] : []),
		...(items === false ? [Arr.isArray(prefixItems) ? prefixItems.length : 0] : [])
	])
	const minima = Arr.flatMap(nodes, ({ minItems }) =>
		Predicate.isNumber(minItems) ? [minItems] : []
	)

	return {
		...(Arr.isReadonlyArrayNonEmpty(maxima) ? { maxParts: Arr.min(maxima, Order.Number) } : {}),
		...(Arr.isReadonlyArrayNonEmpty(minima) ? { minParts: Arr.max(minima, Order.Number) } : {})
	}
}

/**
 * The rules a positional `multipart/mixed` command sends (design 6.3, HT:B15), or the reason the
 * writer cannot send them exactly (a `CliRefusal` subject). Refused, not guessed: a position with
 * part headers (a stretch HT:B15 does not commit), a nested part (M3-MP3), a style other than
 * exploded `form`, and a rule whose `contentType` lists several types or a range.
 */
export const mixedParts = (
	alternative: MediaAlternative,
	defs: JsonObject
): Result.Result<MixedPlan, string> => {
	const prefix: PositionRule[] = []
	for (const [index, rule] of alternative.prefixEncoding.entries()) {
		const built = positionRule(rule, index)
		if (Result.isFailure(built)) {
			return Result.fail(built.failure)
		}

		prefix.push(built.success)
	}

	const bounds = partBounds(bodyNodes(defs, alternative))
	if (alternative.itemEncoding === undefined) {
		return Result.succeed({ ...bounds, prefix })
	}

	return Result.map(positionRule(alternative.itemEncoding, prefix.length), (item) => ({
		...bounds,
		item,
		prefix
	}))
}

const positionEntry = (rule: PositionRule): Expr =>
	obj([
		...(rule.contentEncoding === undefined
			? []
			: ([["contentEncoding", str(rule.contentEncoding)]] as const)),
		["contentType", str(rule.contentType)]
	])

interface BodyParts {
	readonly declarations: readonly Statement[]
	readonly entry?: readonly [string, Expr]
	readonly fields: readonly Field[]
}

/**
 * One form-urlencoded property's Encoding Object fields: those its rule sets, `style` only when a
 * query style (design 6.3); none for a property with no rule. An explicit Encoding `contentType`
 * has no runtime input yet.
 */
const formEncoding = (
	alternative: Pick<MediaAlternative, "encoding" | "mediaType">,
	name: string
): Effect.Effect<Expr, ApiEmitError> =>
	Option.match(ruleNamed(alternative.encoding, name), {
		onNone: () => Effect.succeed(obj([])),
		onSome: ([rule]) => {
			const { serialization } = rule
			const style = serialization?.style
			if (style !== undefined && !queryStyles.has(style)) {
				return Effect.fail(refuse("unsupported-encoding", `${alternative.mediaType}:${name}`))
			}

			return Effect.succeed(
				obj([
					...(serialization?.allowReserved === undefined
						? []
						: ([["allowReserved", bool(serialization.allowReserved)]] as const)),
					...brackets(rule.nonStandard),
					...(serialization?.explode === undefined
						? []
						: ([["explode", bool(serialization.explode)]] as const)),
					...scalars(rule.nonStandardScalars),
					...(style === undefined ? [] : ([["style", str(style)]] as const))
				])
			)
		}
	})

/**
 * The `properties` option of a form object (design 6.3): each property of its object root, from
 * its `allOf` nodes in document order, with the Encoding Object fields of its rule.
 */
const formProperties = (
	alternative: Pick<MediaAlternative, "encoding" | "mediaType">,
	nodes: readonly JsonObject[]
): Effect.Effect<Expr, ApiEmitError> =>
	Effect.map(
		Effect.forEach(objectSchemas(nodes).properties.keys(), (name) =>
			Effect.map(formEncoding(alternative, name), (encoding) => arr([str(name), encoding]))
		),
		arr
	)

/**
 * Whether a body with several media alternatives is encoded per alternative: one of them is form
 * or multipart, so its bytes depend on the key the operator chose (design 6.6). The `api/` builder
 * then takes the whole `Serialize.Chosen`, and the `cli/` command passes `Input.selectBody`'s
 * choice to it unchanged.
 */
export const encodesByKey = (alternatives: readonly MediaAlternative[]): boolean =>
	alternatives.length > 1 &&
	Arr.some(
		alternatives,
		(alternative) => alternative.codec === "form" || alternative.codec === "multipart"
	)

/**
 * How one alternative's body value is typed and sent: `encode` takes the value and the
 * `Content-Type` expressions; `typed` is whether it reads the second; `declarations` declare the
 * value's type when the encoder names one.
 */
interface Encoder {
	readonly declarations: readonly Statement[]
	readonly encode: (value: Expr, contentType: Expr) => Expr
	readonly type: TypeExpr
	readonly typed: boolean
}

const bytesEncoder: Encoder = {
	declarations: [],
	encode: (value, contentType) => fn("body", [contentType, value]),
	type: typeRef(fixedIdentifier("Serialize"), [fixedMemberName("Body")]),
	typed: true
}

/**
 * What a body's encoders are built from: its command, the schema store, the operation's media
 * declaration, and the body's `required` mark as the builder passes it.
 */
interface EncoderContext {
	readonly command: PlannedCommand
	readonly defs: JsonObject
	readonly media: Identifier
	readonly required: Expr
}

/**
 * A positional `multipart/mixed` body's encoder (HT:B15): its part bodies in order, sent by
 * `Serialize.mixed` under the position rules and the schema's count bounds, or none when the writer
 * cannot send the rules exactly.
 */
const mixedEncoder = (
	alternative: MediaAlternative,
	defs: JsonObject,
	required: Expr
): Option.Option<Encoder> => {
	const mixed = mixedParts(alternative, defs)
	if (Result.isFailure(mixed)) {
		return Option.none()
	}

	const { item, maxParts, minParts, prefix } = mixed.success
	const options = obj([
		...(item === undefined ? [] : ([["itemEncoding", positionEntry(item)]] as const)),
		...(maxParts === undefined ? [] : ([["maxParts", num(maxParts)]] as const)),
		...(minParts === undefined ? [] : ([["minParts", num(minParts)]] as const)),
		["prefixEncoding", arr(Arr.map(prefix, positionEntry))],
		["required", required]
	])

	return Option.some<Encoder>({
		declarations: [],
		encode: (value) => fn("mixed", [value, options]),
		type: typeRef(fixedIdentifier("Serialize"), [fixedMemberName("MixedParts")]),
		typed: false
	})
}

/**
 * A nesting part's `Serialize.FormPartEntry` rule: a by-name part's `NestedForm`, its nested
 * parts' names and types, or a by-position part's `PositionalForm`, its flag and position types
 * (HT:B16); none for a part that does not nest.
 */
const nestingForm = (part: Pick<FormPart, "flag" | "nested" | "positions">): Expr | undefined => {
	if (part.positions !== undefined) {
		const { item, positions } = part.positions

		return obj([
			["flag", str(part.flag.name)],
			...(item === undefined ? [] : ([["item", str(item)]] as const)),
			["kind", str("mixed")],
			["positions", arr(Arr.map(positions, (type) => str(type)))]
		])
	}

	return part.nested === undefined
		? undefined
		: obj([
				["kind", str(part.nested.kind)],
				[
					"parts",
					arr(Arr.map(part.nested.parts, (inner) => arr([str(inner.name), str(inner.contentType)])))
				]
			])
}

/**
 * One alternative's encoder (design 4.5, 6.3). A form body is its JSON value, or `undefined` for
 * no body input, encoded by `Serialize.urlEncoded` over the schema's properties in document order;
 * a form alternative with refused fields passes its operation's `media` declaration's `refused`
 * list, the one list `--describe` also reads (design 8.5 rule 6). A positional multipart body is
 * its parts' bytes in order, streamed by `Serialize.mixed`. Any other multipart body the writer can
 * send is its part values, streamed by `Serialize.formData`: a keyed part travels with its type and
 * header values in the form, so a part not sent has no type or header to give (ENC-10, ENC-03),
 * and a chosen type's union is its own alias, named after the form and the part's key, so the field
 * line stays short however many types it lists. Any other body is an `HttpBody` that
 * `Serialize.body` sends. A multipart body the writer cannot send has no encoder (`None`); `cli/`
 * refuses its operation. A multipart body with a chosen part type is the `formName` interface.
 */
const encoderOf = (
	context: EncoderContext,
	alternative: MediaAlternative,
	formName: string
): Effect.Effect<Option.Option<Encoder>, ApiEmitError> =>
	Effect.gen(function* encoder() {
		const { command, defs, media, required } = context
		if (alternative.codec === "form" && !isRange(alternative.mediaType)) {
			const properties = yield* formProperties(alternative, bodyNodes(defs, alternative))
			const options = obj([
				["properties", properties],
				...(refusedFieldsOf(alternative).length > 0
					? ([["refused", member(ident(media), fixedMemberName("refused"))]] as const)
					: []),
				["required", required]
			])

			return Option.some<Encoder>({
				declarations: [],
				encode: (value, contentType) => fn("urlEncoded", [contentType, value, options]),
				type: optionalOf(jsonType),
				typed: true
			})
		}

		if (alternative.codec !== "multipart") {
			return Option.some(bytesEncoder)
		}

		if (isPositionalBody(alternative)) {
			return mixedEncoder(alternative, defs, required)
		}

		const parts = formParts(command, alternative, defs)
		if (Result.isFailure(parts)) {
			return Option.none()
		}

		const aliases: Statement[] = []
		const keyed: Field[] = []
		const sends: ((form: Expr) => Expr)[] = []
		for (const part of parts.success) {
			const { contentEncoding, contentType, key, name } = part
			const encoding = contentEncoding === undefined ? [] : [str(contentEncoding)]
			const nesting = nestingForm(part)
			if (nesting !== undefined) {
				sends.push(() => arr([str(name), nesting]))
				continue
			}

			if (key === undefined && contentType._tag === "Declared") {
				sends.push(() => arr([str(name), str(contentType.mediaType), ...encoding]))
				continue
			}

			const formKey = key ?? name
			let typeArgument: TypeExpr
			if (contentType._tag === "Declared") {
				typeArgument = typeLiteral(contentType.mediaType)
			} else {
				const alias = yield* identifier(`${formName}${Str.capitalize(formKey)}ContentType`)
				aliases.push({
					_tag: "TypeAlias",
					doc: yield* docText("The content types the operator may choose for one multipart part."),
					name: alias,
					type: typeUnion(Arr.map(contentType.choices, (choice) => typeLiteral(choice)))
				})
				typeArgument = typeName(alias)
			}

			keyed.push({
				key: formKey,
				optional: true,
				type: optionalOf(
					typeApply(fixedIdentifier("Serialize"), [fixedMemberName("ChosenPart")], [typeArgument])
				)
			})

			const slot = yield* memberName(formKey)
			sends.push((form) => arr([str(name), member(form, slot), ...encoding]))
		}

		const options = (form: Expr) =>
			obj([
				["parts", arr(Arr.map(sends, (send) => send(form)))],
				["required", required]
			])
		const fields = typeRef(fixedIdentifier("Serialize"), [fixedMemberName("FormFields")])
		if (keyed.length === 0) {
			return Option.some<Encoder>({
				declarations: [],
				encode: (value) => fn("formData", [value, options(value)]),
				type: fields,
				typed: false
			})
		}

		const name = yield* identifier(formName)
		const doc = yield* docText(
			"The multipart parts: fields holds each part with one listed content type and no declared header; each other part carries its content type and header values, or is absent when not sent."
		)

		return Option.some<Encoder>({
			declarations: [
				...aliases,
				{
					_tag: "Interface",
					doc,
					fields: [{ key: "fields", optional: false, type: fields }, ...keyed],
					name
				}
			],
			encode: (value) => fn("formData", [member(value, fixedMemberName("fields")), options(value)]),
			type: typeName(name),
			typed: false
		})
	})

/**
 * A body encoded per alternative (`encodesByKey`): the `<Op>Bodies` interface maps each key the
 * builder sends to its value type, the input is the choice `Input.selectBody` made, and
 * `Serialize.alternatives` calls the chosen key's encoder, with annotated parameters. A multipart
 * alternative the writer cannot send is left out, so no builder sends multipart without its
 * boundary; `cli/` refuses that operation.
 */
const chosenParts = (
	context: EncoderContext,
	alternatives: readonly MediaAlternative[],
	name: Identifier,
	formName: string
) =>
	Effect.gen(function* chosen() {
		const declarations: Statement[] = []
		const fields: Field[] = []
		const table: (readonly [string, Expr])[] = []
		for (const alternative of alternatives) {
			const forms = declarations.length
			const numbered = forms === 0 ? formName : `${formName}${forms + 1}`
			const found = yield* encoderOf(context, alternative, numbered)
			if (Option.isNone(found)) {
				continue
			}

			const encoder = found.value
			const { mediaType } = alternative
			const sent = isRange(mediaType) ? typeKeyword("string") : typeLiteral(mediaType)
			const params: Param[] = [{ name: fixedIdentifier("body"), type: encoder.type }]
			if (encoder.typed) {
				params.push({ name: fixedIdentifier("contentType"), type: sent })
			}

			for (const declaration of encoder.declarations) {
				declarations.push(declaration)
			}

			fields.push({ key: mediaType, optional: false, type: encoder.type })
			table.push([
				mediaType,
				arrow(
					params,
					encoder.encode(ident(fixedIdentifier("body")), ident(fixedIdentifier("contentType")))
				)
			])
		}

		const value = member(ident(fixedIdentifier("input")), fixedMemberName("body"))

		return {
			declarations: [...declarations, { _tag: "Interface", fields, name }],
			entry: ["body", fn("alternatives", [value, obj(table)])],
			fields: [
				{
					key: "body",
					optional: false,
					type: typeApply(
						fixedIdentifier("Serialize"),
						[fixedMemberName("Chosen")],
						[typeName(name)]
					)
				}
			]
		} satisfies BodyParts
	})

/**
 * The body is always present in `Input` when the operation declares one: an optional body with
 * no input is `HttpBody.empty`, which `Serialize.request` sends without `Content-Type`. A lone
 * alternative is sent by its own encoder under its media type. The content type is an input when
 * the operator chooses it among bytes alternatives, or under a range key; a body with a form or
 * multipart alternative among several is encoded per key (`chosenParts`). `formName` names a
 * multipart body with a chosen part type.
 */
const bodyParts = (
	command: PlannedCommand,
	defs: JsonObject,
	bodies: Identifier,
	formName: string,
	media: Identifier
): Effect.Effect<BodyParts, ApiEmitError> =>
	Effect.gen(function* parts() {
		const { body } = command.operation
		if (body === undefined || !Arr.isReadonlyArrayNonEmpty(body.alternatives)) {
			return { declarations: [], fields: [] }
		}

		const { alternatives } = body
		const context: EncoderContext = { command, defs, media, required: bool(body.required) }
		if (encodesByKey(alternatives)) {
			return yield* chosenParts(context, alternatives, bodies, formName)
		}

		const first = Arr.headNonEmpty(alternatives)
		const input = ident(fixedIdentifier("input"))
		const value = member(input, fixedMemberName("body"))
		if (alternatives.length === 1 && !isRange(first.mediaType)) {
			const found = yield* encoderOf(context, first, formName)
			const encoder = Option.getOrElse(found, () => bytesEncoder)

			return {
				declarations: encoder.declarations,
				entry: ["body", encoder.encode(value, str(first.mediaType))],
				fields: [{ key: "body", optional: false, type: encoder.type }]
			}
		}

		const types = mediaTypes(alternatives)
		const contentType: Field = {
			key: "contentType",
			optional: false,
			type: Arr.some(types, isRange)
				? typeKeyword("string")
				: typeUnion(Arr.map(types, (type) => typeLiteral(type)))
		}

		return {
			declarations: [],
			entry: ["body", bytesEncoder.encode(value, member(input, fixedMemberName("contentType")))],
			fields: [{ key: "body", optional: false, type: bytesEncoder.type }, contentType]
		}
	})

const serverEntry = (server: Server): Expr => {
	const entries: (readonly [string, Expr])[] = [["url", str(server.template)]]
	if (server.name !== undefined) {
		entries.push(["name", str(server.name)])
	}

	if (server.variables.length > 0) {
		const variables = Arr.map(server.variables, (variable) => {
			const fields: (readonly [string, Expr])[] = [["default", str(variable.default)]]
			if (variable.enum !== undefined) {
				fields.push(["enum", strings(variable.enum)])
			}

			return [variable.name, obj(fields)] as const
		})
		entries.push(["variables", obj(variables)])
	}

	return obj(entries)
}

/**
 * The servers table: every server of the level, the first accepted one as the default, and the
 * bound origin set of that level's servers (design 6.4).
 */
const serversTable = (servers: readonly Server[], bound: ApiEmitInput["boundOrigins"]): Expr =>
	obj([
		["boundOrigins", strings(bound(servers))],
		["servers", arr(Arr.map(servers, serverEntry))],
		...Option.match(
			Arr.findFirstIndex(servers, (server) => server.accepted),
			{
				onNone: () => [],
				onSome: (accepted) => [["defaultServer", num(accepted)] as const]
			}
		)
	])

const requestIdNames: ReadonlySet<string> = new Set([
	"request-id",
	"x-request-id",
	"x-correlation-id"
])

/**
 * The first declared response header, in response-key then document order, named `request-id`,
 * `x-request-id` or `x-correlation-id` in any case (design 7.1), with its declared spelling.
 */
const requestIdHeaderOf = (responses: Operation["responses"]): Option.Option<string> =>
	Option.map(
		Arr.findFirst(
			Arr.flatMap(responses, (response) => response.headers),
			(header) => requestIdNames.has(Str.toLowerCase(header.name))
		),
		(header) => header.name
	)

/**
 * The required response headers of each case that declares any, keyed as the media table keys the
 * case, each list in document order (design 7.3; HDR-03).
 */
const requiredHeadersOf = (responses: Operation["responses"]): (readonly [string, Expr])[] =>
	Arr.flatMap(responses, (response) => {
		const names = Arr.map(
			Arr.filter(response.headers, (header) => header.required),
			(header) => header.name
		)

		return names.length === 0 ? [] : [[responseKey(response.key), strings(names)] as const]
	})

interface Markable {
	readonly schema: { readonly key: string }
	readonly sensitive?: true | undefined
}

/**
 * The header parameters and multipart part headers the document marks sensitive, by `x-sensitive:
 * true` or a password schema (`isPasswordSchema`), each name once in document order: the runtime's
 * `--dry-run` and `--verbose` redact their values (`Auth.sensitiveHeaderNames`).
 */
const sensitiveHeadersOf = (operation: Operation, defs: JsonObject): readonly string[] => {
	const marked = (header: Markable): boolean =>
		header.sensitive === true || isPasswordSchema(defs, header.schema.key)
	const parameters = pipe(
		operation.parameters,
		Arr.filter((parameter) => parameter.location === "header" && marked(parameter)),
		Arr.map((parameter) => parameter.wireName)
	)
	const parts = pipe(
		operation.body?.alternatives ?? [],
		Arr.filter((alternative) => alternative.codec === "multipart"),
		Arr.flatMap((alternative) => alternative.encoding),
		Arr.flatMap((rule): readonly NestedRule[] => [
			rule,
			...(rule.nested ?? []),
			...(rule.nestedItem === undefined ? [] : [rule.nestedItem])
		]),
		Arr.flatMap((rule) => rule.headers),
		Arr.filter(marked),
		Arr.map((header) => header.name)
	)

	return Arr.dedupe([...parameters, ...parts])
}

const requirementOf = (operation: Operation, schemes: ReadonlySet<string>) =>
	Effect.gen(function* requirement() {
		const alternatives = Arr.map(operation.security.alternatives, (alternative) =>
			Arr.map(alternative.uses, (use) => use.scheme)
		)
		const unknown = Arr.findFirst(Arr.flatten(alternatives), (scheme) => !schemes.has(scheme))
		if (Option.isSome(unknown)) {
			return yield* refuse("unknown-scheme", unknown.value)
		}

		return arr(Arr.map(alternatives, strings))
	})

interface CommandContext extends ParameterContext {
	readonly bound: ApiEmitInput["boundOrigins"]
	readonly document: (uri: string) => string
	readonly domain: ReadonlyMap<string, SafeIdentifier>
	readonly schemes: ReadonlySet<string>
}

/**
 * An operation's statements: its body's declarations and its `Input` interface, its builder, its
 * media declaration, its security requirement, its event table when it has one, and its meta. Only
 * an operation with cookie parameters names `cookies`, and only one that declares a request id
 * candidate names it, so M1 output is unchanged (C16); only one that declares a required response
 * header names that table (HDR-03), and only one with a header the document marks sensitive names
 * that list. An operation with no input takes no argument: an empty interface and an unused
 * parameter fail the package's own lint.
 */
const commandStatements = (
	command: PlannedCommand,
	path: string,
	context: CommandContext
): Effect.Effect<readonly Statement[], ApiEmitError> =>
	Effect.gen(function* statements() {
		const { operation } = command
		const name = command.identifier
		const capitalized = Str.capitalize(name)
		const inputName = yield* identifier(`${capitalized}Input`)
		const mediaName = yield* identifier(`${name}Media`)
		const securityName = yield* identifier(`${name}Security`)
		const eventsName = yield* identifier(`${name}Events`)
		const eventTable = yield* eventTableOf(operation.responses, context.domain)
		const parameters = yield* Effect.forEach(inputKeys(operation), (entry) =>
			parameterParts(entry, context)
		)
		const bodies = yield* identifier(`${capitalized}Bodies`)
		const body = yield* bodyParts(command, context.defs, bodies, `${capitalized}Form`, mediaName)
		const callsIn = (list: ParameterList): readonly Expr[] =>
			Arr.flatMap(parameters, (part) => (part.list === list ? [part.call] : []))
		const cookies = callsIn("cookies")
		const parts: (readonly [string, Expr])[] = [
			["headers", arr(callsIn("headers"))],
			["path", fn("path", [str(operation.key.path), arr(callsIn("path"))])],
			["query", arr(callsIn("query"))]
		]
		if (body.entry !== undefined) {
			parts.push(body.entry)
		}

		if (cookies.length > 0) {
			parts.push(["cookies", arr(cookies)])
		}

		const fields = [...body.fields, ...Arr.getSomes(Arr.map(parameters, (part) => part.field))]
		const builder = typedArrow(
			fields.length === 0 ? [] : [{ name: fixedIdentifier("input"), type: typeName(inputName) }],
			fn("request", [str(operation.key.method), obj(parts)]),
			typeRef(fixedIdentifier("Serialize"), [fixedMemberName("Request")])
		)
		const requested = operation.body?.alternatives ?? []
		const refused = refusedEntry(requested)
		const media = obj([
			...(Option.isSome(refused) ? ([["refused", refused.value]] as const) : []),
			["request", strings(mediaTypes(requested))],
			[
				"responses",
				obj(
					Arr.map(
						operation.responses,
						(response) =>
							[responseKey(response.key), strings(mediaTypes(response.alternatives))] as const
					)
				)
			]
		])
		const meta: (readonly [string, Expr])[] = [
			...(operation.deprecated ? ([["deprecated", bool(true)]] as const) : []),
			...(eventTable.length === 0 ? [] : ([["events", ident(eventsName)]] as const)),
			["media", ident(mediaName)],
			["method", str(operation.key.method)],
			[
				"origin",
				obj([
					["document", str(context.document(operation.origin.document))],
					["pointer", str(operation.origin.pointer)]
				])
			],
			["pathTemplate", str(operation.key.path)],
			["security", ident(securityName)]
		]
		if (operation.operationId !== undefined) {
			meta.push(["operationId", str(operation.operationId)])
		}

		const requestId = requestIdHeaderOf(operation.responses)
		if (Option.isSome(requestId)) {
			meta.push(["requestIdHeader", str(requestId.value)])
		}

		const requiredHeaders = requiredHeadersOf(operation.responses)
		if (requiredHeaders.length > 0) {
			meta.push(["requiredHeaders", obj(requiredHeaders)])
		}

		const sensitiveHeaders = sensitiveHeadersOf(operation, context.defs)
		if (sensitiveHeaders.length > 0) {
			meta.push(["sensitiveHeaders", strings(sensitiveHeaders)])
		}

		if (Arr.some(operation.servers, (server) => server.level !== "root")) {
			meta.push(["servers", serversTable(operation.servers, context.bound)])
		}

		const declarations: readonly Statement[] = [
			...body.declarations,
			...(fields.length === 0 ? [] : [{ _tag: "Interface", fields, name: inputName } as const])
		]
		const builderDoc = yield* docText(`Request builder for ${path}, not an HttpApi definition.`)
		const requirement = yield* requirementOf(operation, context.schemes)
		const metaName = yield* identifier(`${name}Meta`)

		return [
			...declarations,
			{
				_tag: "Const",
				doc: builderDoc,
				exported: true,
				name,
				value: builder
			},
			{
				_tag: "Const",
				exported: false,
				name: mediaName,
				type: typeName(fixedIdentifier("MediaDeclaration")),
				value: media
			},
			{
				_tag: "Const",
				exported: false,
				name: securityName,
				type: typeName(fixedIdentifier("SecurityRequirement")),
				value: requirement
			},
			...(eventTable.length === 0
				? []
				: [
						{
							_tag: "Const",
							exported: false,
							name: eventsName,
							type: typeName(fixedIdentifier("EventTable")),
							value: obj(eventTable)
						} as const
					]),
			{ _tag: "Const", exported: true, name: metaName, value: obj(meta) }
		]
	})

/**
 * An operation's builder, `Meta`, `Media`, `Security` and `Input` belong to its primary command
 * alone; its alias commands call them (design 4.4). An operation with a parameter this layer does
 * not build has none: `emitCli` refuses it.
 */
const primaries = (commands: readonly PlannedCommand[]): readonly PlannedCommand[] =>
	Arr.filter(
		commands,
		(command) =>
			command.alias === undefined && Arr.every(command.operation.parameters, buildsParameter)
	)

/**
 * One `api/` module: the statements of each of its primary commands. Declaration names are composed
 * from command identifiers and form keys; two compositions that spell the same name are refused
 * rather than printed twice.
 */
const moduleFile = (
	segment: string,
	commands: readonly PlannedCommand[],
	prefix: string,
	context: CommandContext
) =>
	Effect.gen(function* file() {
		const byCommand = yield* Effect.forEach(commands, (command) =>
			commandStatements(command, `${prefix}${command.name}`, context)
		)
		const statements = Arr.flatten(byCommand)
		const declared = new Set<string>()
		for (const statement of statements) {
			if (statement._tag !== "Expression") {
				if (declared.has(statement.name)) {
					return yield* refuse("unprintable-name", statement.name)
				}

				declared.add(statement.name)
			}
		}

		const content = yield* printModule({
			imports: [
				...groupImports,
				...(Arr.some(commands, (command) => hasEventTable(command.operation))
					? [eventTableImport]
					: []),
				...(Arr.some(commands, (command) => checksEventData(command.operation))
					? [domainImport]
					: [])
			],
			statements
		})

		return { content, path: `src/api/${segment}.ts` }
	})

/** The visible command path of a group, parents first, followed by a space. */
const groupPrefix = (group: PlannedGroup, byTag: ReadonlyMap<string, PlannedGroup>): string => {
	const names = [group.name]
	const seen = new Set([group.tag])
	let parent = group.parent === undefined ? undefined : byTag.get(group.parent)
	while (parent !== undefined && !seen.has(parent.tag)) {
		names.unshift(parent.name)
		seen.add(parent.tag)
		parent = parent.parent === undefined ? undefined : byTag.get(parent.parent)
	}

	return `${Arr.join(names, " ")} `
}

/** A scheme the document marks deprecated carries `deprecated: true`; any other prints no field. */
const deprecation = (scheme: SecurityScheme): readonly (readonly [string, Expr])[] =>
	scheme.deprecated ? [["deprecated", bool(true)]] : []

type OAuthFlows = Extract<SecurityScheme["kind"], { readonly type: "oauth2Token" }>["flows"]

type OAuthFlow = NonNullable<OAuthFlows[keyof OAuthFlows]>

const flowKinds = [
	"authorizationCode",
	"clientCredentials",
	"deviceAuthorization",
	"implicit",
	"password"
] as const satisfies readonly (keyof OAuthFlows)[]

/** An optional help-only string field prints only when the spec gave it. */
const present = (name: string, value: string | undefined): readonly (readonly [string, Expr])[] =>
	value === undefined ? [] : [[name, str(value)]]

const flowExpr = (flow: OAuthFlow): Expr =>
	obj([
		...present("authorizationUrl", flow.authorizationUrl),
		...present("deviceAuthorizationUrl", flow.deviceAuthorizationUrl),
		...present("refreshUrl", flow.refreshUrl),
		[
			"scopes",
			arr(
				Arr.map(flow.scopes, (scope) =>
					obj([
						["description", str(scope.description)],
						["name", str(scope.name)]
					])
				)
			)
		],
		...present("tokenUrl", flow.tokenUrl)
	])

/** An `oauth2` scheme's flows, help-only data the runtime never sends (design 9 I3). */
const flowsExpr = (flows: OAuthFlows): Expr =>
	obj(
		Arr.flatMap(flowKinds, (flowKind) => {
			const flow = flows[flowKind]

			return flow === undefined ? [] : [[flowKind, flowExpr(flow)] as const]
		})
	)

const runtimeScheme = (scheme: SecurityScheme, env: string): Effect.Effect<Expr, ApiEmitError> => {
	const { kind } = scheme
	if (kind.type === "apiKey") {
		return Effect.succeed(
			obj([
				...deprecation(scheme),
				["env", str(env)],
				["in", str(kind.in)],
				["kind", str("apiKey")],
				["name", str(kind.name)]
			])
		)
	}

	if (kind.type === "http") {
		return Effect.succeed(
			obj([
				...deprecation(scheme),
				["env", str(env)],
				["kind", str("http")],
				["scheme", str(kind.scheme)]
			])
		)
	}

	if (kind.type === "oauth2Token") {
		return Effect.succeed(
			obj([
				...deprecation(scheme),
				["env", str(env)],
				["flows", flowsExpr(kind.flows)],
				["kind", str("oauth2")]
			])
		)
	}

	if (kind.type === "oidcToken") {
		return Effect.succeed(
			obj([
				...deprecation(scheme),
				["env", str(env)],
				["kind", str("openIdConnect")],
				["openIdConnectUrl", str(kind.openIdConnectUrl)]
			])
		)
	}

	return Effect.fail(refuse("unsupported-scheme", scheme.name))
}

/**
 * A `mutualTLS` scheme's descriptor: the certificate environment names the plan derived (design
 * 4.4), which the runtime reads `Config` by; never a header.
 */
const certificateScheme = (scheme: SecurityScheme, names: PlannedCertificate): Expr =>
	obj([
		["caEnv", str(names.caEnv)],
		["certEnv", str(names.certEnv)],
		...deprecation(scheme),
		["keyEnv", str(names.keyEnv)],
		["kind", str("mutualTLS")]
	])

const byEntryScheme = Order.mapInput(
	Order.String,
	(entry: { readonly scheme: string }) => entry.scheme
)

const securityFile = (api: Api, plan: NamePlan) =>
	Effect.gen(function* file() {
		const entries = Arr.sort(
			[
				...Arr.map(plan.credentials, (credential) => ({
					describe: (scheme: SecurityScheme) => runtimeScheme(scheme, credential.env),
					scheme: credential.scheme
				})),
				...Arr.map(plan.certificates, (names) => ({
					describe: (scheme: SecurityScheme) => Effect.succeed(certificateScheme(scheme, names)),
					scheme: names.scheme
				}))
			],
			byEntryScheme
		)
		const schemes = yield* Effect.forEach(entries, (entry) =>
			Option.match(
				Arr.findFirst(api.securitySchemes, (candidate) => candidate.name === entry.scheme),
				{
					onNone: () => Effect.fail(refuse("unknown-scheme", entry.scheme)),
					onSome: (scheme) =>
						Effect.map(entry.describe(scheme), (value) => [entry.scheme, value] as const)
				}
			)
		)
		const content = yield* printModule({
			imports: [
				{
					_tag: "Named",
					from: fixedModuleSpecifier("../runtime/auth.ts"),
					names: [fixedIdentifier("SecurityTable")],
					typeOnly: true
				}
			],
			statements: [
				{
					_tag: "Const",
					exported: true,
					name: fixedIdentifier("security"),
					type: typeName(fixedIdentifier("SecurityTable")),
					value: obj([["schemes", obj(schemes)]])
				}
			]
		})

		return { content, path: "src/api/security.ts" }
	})

const serversFile = (api: Api, bound: ApiEmitInput["boundOrigins"]) =>
	printModule({
		imports: [
			{
				_tag: "Named",
				from: fixedModuleSpecifier("../runtime/base-url.ts"),
				names: [fixedIdentifier("ServersTable")],
				typeOnly: true
			}
		],
		statements: [
			{
				_tag: "Const",
				exported: true,
				name: fixedIdentifier("servers"),
				type: typeName(fixedIdentifier("ServersTable")),
				value: serversTable(api.servers, bound)
			}
		]
	}).pipe(Effect.map((content) => ({ content, path: "src/api/servers.ts" })))

const byPath = Order.mapInput(Order.String, (file: EmittedFile) => file.path)

/**
 * Emits the V1 `api/` layer (design 4.1, 4.4, 4.8, 6.4, 6.5; §14 D1, D6): `api/<group>.ts` per
 * planned group and `api/root.ts` for untagged commands that hold a primary command, each
 * operation once, under its primary command, with its `Input` type, a pure request builder over
 * `runtime/serialize`, its media declaration, its security requirement and its meta (servers only
 * when the operation or path item overrides them); `api/servers.ts`; and `api/security.ts` with
 * every scheme the planned operations use. Builders read no flag. Files are sorted by path.
 */
export const emitApi = (
	input: ApiEmitInput
): Effect.Effect<readonly EmittedFile[], ApiEmitError | PrinterError> =>
	Effect.gen(function* emit() {
		const { api, plan } = input
		const reserved = Arr.findFirst(plan.groups, (group) => reservedSegments.has(group.segment))
		if (Option.isSome(reserved)) {
			return yield* refuse("reserved-segment", reserved.value.segment)
		}

		const context: CommandContext = {
			bound: input.boundOrigins,
			defs: api.schemas.defs,
			document: (uri) => documentLabel(api.entry, uri),
			domain: plan.domain,
			line: api.line,
			memo: new Map(),
			schemes: new Set(
				Arr.map([...plan.credentials, ...plan.certificates], (credential) => credential.scheme)
			)
		}
		const byTag = new Map(Arr.map(plan.groups, (group) => [group.tag, group] as const))
		const withPrimaries = Arr.filter(plan.groups, (group) => primaries(group.commands).length > 0)
		const groups = yield* Effect.forEach(withPrimaries, (group) =>
			moduleFile(group.segment, primaries(group.commands), groupPrefix(group, byTag), context)
		)
		const rootPrimaries = primaries(plan.root)
		const root =
			rootPrimaries.length === 0 ? [] : [yield* moduleFile("root", rootPrimaries, "", context)]
		const security = yield* securityFile(api, plan)
		const servers = yield* serversFile(api, input.boundOrigins)

		return Arr.sort([...groups, ...root, security, servers], byPath)
	})
