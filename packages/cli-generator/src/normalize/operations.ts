import {
	Array as Arr,
	Effect,
	Equal,
	HashSet,
	Option,
	Order,
	Record,
	Result,
	Schema,
	String as Str,
	Struct
} from "effect"
import type { Types } from "effect"
import { isMethodToken, isNonEmptyText, isPathTemplate, stripUnsafeText } from "#model/brands.ts"
import type { MethodToken, PathTemplate } from "#model/brands.ts"
import { makeDiagnostic, pointerOrder } from "#model/diagnostic.ts"
import type { Diagnostic, DiagnosticOperation } from "#model/diagnostic.ts"
import { ContentSerialization, Operation, Parameter as ParameterEntity } from "#model/entities.ts"
import type {
	Body,
	Naming,
	NamingAlias,
	NamingHint,
	Parameter,
	RowId,
	Server
} from "#model/entities.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { methodMembers } from "#model/path-item.ts"
import { childPointer, formatPointer, parsePointerResult } from "#model/pointer.ts"
import type { Json, JsonPointer } from "#model/pointer.ts"
import { specSectionUrl } from "#model/spec-section.ts"
import {
	BodyOutcome,
	FormContentOutcome,
	formContentRules,
	hintDiscriminators,
	normalizeBody
} from "#normalize/bodies.ts"
import type { BodyNotReadable, BodySite } from "#normalize/bodies.ts"
import { follow, nodeOption } from "#normalize/document-set.ts"
import { authorChoiceCodes, normalizeParameter, ParameterOutcome } from "#normalize/parameters.ts"
import type { ParameterNotReadable, ParameterSite } from "#normalize/parameters.ts"
import { normalizeResponses } from "#normalize/responses.ts"
import { normalizeSecurityPolicy } from "#normalize/security.ts"
import type { SchemeNormalization } from "#normalize/security.ts"
import { effectiveServers } from "#normalize/servers.ts"
import type { ServerSource, ServersContext } from "#normalize/servers.ts"
import { referenceAt } from "#resolve/index.ts"
import type { Resolution } from "#resolve/index.ts"
import * as Read from "#runtime/read.ts"

/**
 * The operations of the entry document and the diagnostics found assembling them. An operation
 * that an operation-scope refusal removed is absent from `operations` and named in `diagnostics`.
 */
export interface OperationAssembly {
	readonly diagnostics: readonly Diagnostic[]
	readonly operations: readonly Operation[]
}

/**
 * Assembly fails only where a stage below it does: a site validation or resolution should have
 * stopped.
 */
export type OperationsError = BodyNotReadable | ParameterNotReadable

type Level = "operation" | "pathItem"

/**
 * A node of the entry document and the reference tokens of its pointer.
 */
interface Located {
	readonly node: Json
	readonly tokens: ReadonlyArray<string>
}

interface Rule {
	readonly anchor: string
	readonly element: string
	readonly hint?: string
	readonly message: string
	readonly scope: "element" | "operation"
	readonly severity: "notice" | "refusal"
}

const rules = {
	"EXT-01/alias-unnamed": {
		anchor: "specification-extensions",
		element: "Naming extension",
		message: "The alias has no usable group and method name, so it names no command.",
		scope: "element",
		severity: "notice"
	},
	"EXT-01/naming-invalid": {
		anchor: "specification-extensions",
		element: "Naming extension",
		hint: "Give a group as a dotted string or an array of names, and a method as one string.",
		message: "The naming extension value is not a shape this generator reads, so it is ignored.",
		scope: "element",
		severity: "notice"
	},
	"OPR-08/required-parameter-refused": {
		anchor: "operation-parameters",
		element: "Operation parameters",
		hint: "Make the parameter optional, or change it to one this generator implements.",
		message: "A required parameter is refused, so the operation cannot be called.",
		scope: "operation",
		severity: "refusal"
	},
	"OPR-09/required-body-refused": {
		anchor: "operation-request-body",
		element: "Operation request body",
		hint: "Make the body optional, or offer a media type this generator implements.",
		message: "The required request body has no media type that can be sent.",
		scope: "operation",
		severity: "refusal"
	},
	"OPR-10/body-ignored": {
		anchor: "operation-request-body",
		element: "Request body",
		message: "OpenAPI 3.0 says a request body on this method SHALL be ignored, so no body is sent.",
		scope: "element",
		severity: "notice"
	},
	"SEC-06/no-satisfiable-alternative": {
		anchor: "operation-security",
		element: "Operation security",
		hint: "Declare an alternative this generator implements, or `{}` to allow no credential.",
		message: "Every declared security alternative is refused, so the operation cannot be called.",
		scope: "operation",
		severity: "refusal"
	}
} as const satisfies Record<string, Rule>

type Code = keyof typeof rules

/**
 * The members of the document root that assembly reads: its `paths`, by key, and its `servers`, read where they apply.
 */
interface Root {
	readonly paths: Option.Option<Read.Members>
	readonly servers: Option.Option<Json>
}

/**
 * The document root's members, or none when the root is no object or its `paths` is no object.
 */
const rootOf = (value: Json): Option.Option<Root> =>
	isObject(value)
		? Result.getSuccess(
				Read.struct(
					value,
					{
						paths: Read.optionalMember(value, "paths", Read.members),
						servers: Result.succeed(Record.get(value, "servers"))
					},
					Read.anything
				)
			)
		: Option.none()

/**
 * A path item as assembly reads it: its object, its pointer, its `additionalOperations` by key, its `parameters` and its
 * `servers`, read where they apply.
 */
interface PathItem {
	readonly additionalOperations: Option.Option<Read.Members>
	readonly node: JsonObject
	readonly parameters: Option.Option<ReadonlyArray<unknown>>
	readonly pointer: JsonPointer
	readonly servers: Option.Option<Json>
	readonly tokens: ReadonlyArray<string>
}

/**
 * The path item at a located node, or none when the node is no object or holds `additionalOperations` that is no
 * object or `parameters` that is no array.
 */
const pathItemOf = (item: Located): Option.Option<PathItem> => {
	const { node, tokens } = item

	return isObject(node)
		? Result.getSuccess(
				Result.map(
					Read.struct(
						node,
						{
							additionalOperations: Read.optionalMember(node, "additionalOperations", Read.members),
							parameters: Read.optionalMember(node, "parameters", Read.array(Read.anything)),
							servers: Result.succeed(Record.get(node, "servers"))
						},
						Read.anything
					),
					(fields): PathItem => ({ ...fields, node, pointer: formatPointer(tokens), tokens })
				)
			)
		: Option.none()
}

/**
 * The members of an Operation Object that assembly reads; `requestBody` and `servers` are read where they apply.
 */
interface OperationFields {
	readonly deprecated: Option.Option<boolean>
	readonly description: Option.Option<string>
	readonly operationId: Option.Option<string>
	readonly parameters: Option.Option<ReadonlyArray<unknown>>
	readonly requestBody: Option.Option<Json>
	readonly servers: Option.Option<Json>
	readonly summary: Option.Option<string>
	readonly tags: Option.Option<ReadonlyArray<string>>
}

/**
 * An Operation Object's members, or none when one of them is of another type than its own.
 */
const operationFieldsOf = (node: JsonObject): Option.Option<OperationFields> =>
	Result.getSuccess(
		Read.struct(
			node,
			{
				deprecated: Read.optionalMember(node, "deprecated", Read.boolean),
				description: Read.optionalMember(node, "description", Read.string),
				operationId: Read.optionalMember(node, "operationId", Read.string),
				parameters: Read.optionalMember(node, "parameters", Read.array(Read.anything)),
				requestBody: Result.succeed(Record.get(node, "requestBody")),
				servers: Result.succeed(Record.get(node, "servers")),
				summary: Read.optionalMember(node, "summary", Read.string),
				tags: Read.optionalMember(node, "tags", Read.array(Read.string))
			},
			Read.anything
		)
	)

/**
 * A Parameter Object's identity members, `in` and `name`.
 */
const parameterIdentity: Read.Reader<{ readonly in: string; readonly name: string }> = Read.object(
	(node) => ({
		in: Read.member(node, "in", Read.string),
		name: Read.member(node, "name", Read.string)
	}),
	Read.anything
)

const methodRows: ReadonlyMap<string, RowId> = new Map([
	["DELETE", "PTH-17"],
	["GET", "PTH-14"],
	["HEAD", "PTH-19"],
	["OPTIONS", "PTH-18"],
	["PATCH", "PTH-20"],
	["POST", "PTH-16"],
	["PUT", "PTH-15"],
	["QUERY", "PTH-22"],
	["TRACE", "PTH-21"]
])

/**
 * Methods whose request body 3.0 says consumers ignore and 3.1+ leaves undecided (OPR-10, OPR-11).
 */
const bodylessMethods: ReadonlySet<string> = new Set(["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"])

const nodeAt = (resolution: Resolution, pointer: string): Option.Option<Json> =>
	nodeOption(resolution, { document: resolution.document, pointer })

/**
 * The path item at a use site, followed through its Reference Object to the end of the chain. A
 * path item in another document of the set is not read here: the sites of its operations would sit
 * in that document, and assembly walks the entry's sites only.
 */
const locate = (resolution: Resolution, key: string): Option.Option<Located> => {
	const use: ReadonlyArray<string> = ["paths", key]
	const reference = referenceAt(resolution, formatPointer(use))
	if (reference !== undefined && reference.target.document !== resolution.document) {
		return Option.none()
	}

	const tokens =
		reference === undefined
			? Option.some(use)
			: Result.getSuccess(parsePointerResult(reference.target.pointer))

	return Option.flatMap(tokens, (found) =>
		Option.map(nodeAt(resolution, formatPointer(found)), (node): Located => ({
			node,
			tokens: found
		}))
	)
}

interface RawOperation {
	readonly additional: boolean
	readonly fields: OperationFields
	readonly item: PathItem
	readonly method: MethodToken
	readonly node: JsonObject
	readonly path: PathTemplate
	readonly pointer: JsonPointer
	readonly tokens: ReadonlyArray<string>
}

const operationsOfItem = (
	resolution: Resolution,
	path: PathTemplate,
	item: PathItem
): readonly RawOperation[] => {
	const members = new Set(methodMembers(resolution.line))
	const fixed = Arr.map(
		Arr.filter(Record.keys(item.node), (name) => members.has(name)),
		(name) => ({ additional: false, name, token: Str.toUpperCase(name) })
	)
	const extra = Arr.map(
		Record.keys(Option.getOrElse(item.additionalOperations, Record.empty)),
		(name) => ({
			additional: true,
			name,
			token: name
		})
	)

	return Arr.flatMap([...fixed, ...extra], (entry): readonly RawOperation[] => {
		const tokens = entry.additional
			? [...item.tokens, "additionalOperations", entry.name]
			: [...item.tokens, entry.name]
		const pointer = formatPointer(tokens)
		const node = nodeAt(resolution, pointer).pipe(Option.filter(isObject))
		const fields = Option.flatMap(node, operationFieldsOf)
		const method = Option.liftPredicate(entry.token, isMethodToken)

		return Option.isSome(node) && Option.isSome(fields) && Option.isSome(method)
			? [
					{
						additional: entry.additional,
						fields: fields.value,
						item,
						method: method.value,
						node: node.value,
						path,
						pointer,
						tokens
					}
				]
			: []
	})
}

/**
 * An operation's use site under `/paths`: the path key, then the method or its
 * `additionalOperations` entry. Unlike `pointer`, it is unique when path items share a target.
 */
const useSite = (key: string, raw: RawOperation): string => {
	const item = childPointer("/paths", key)

	return raw.additional
		? childPointer(childPointer(item, "additionalOperations"), raw.method)
		: childPointer(item, Str.toLowerCase(raw.method))
}

/**
 * The entry document's operations in canonical order (design 3.7): every operation sits in the
 * entry document, so the order is its use-site pointer token by token. Member order of `paths`,
 * a path item and `additionalOperations` is not semantic and never reaches a later stage.
 */
const rawOperations = (
	resolution: Resolution,
	root: Option.Option<Root>
): readonly RawOperation[] => {
	const keys = Option.match(
		Option.flatMap(root, (read) => read.paths),
		{
			onNone: (): readonly string[] => [],
			onSome: (paths) => Record.keys(paths)
		}
	)
	const sited = Arr.flatMap(keys, (key) => {
		const path = Option.liftPredicate(key, isPathTemplate)
		const item = Option.flatMap(locate(resolution, key), pathItemOf)
		if (Option.isNone(path) || Option.isNone(item)) {
			return []
		}

		return Arr.map(operationsOfItem(resolution, path.value, item.value), (raw) => ({
			raw,
			site: useSite(key, raw)
		}))
	})

	return Arr.map(
		Arr.sort(
			sited,
			Order.mapInput(pointerOrder, (entry: { readonly site: string }) => entry.site)
		),
		(entry) => entry.raw
	)
}

/**
 * A parameter's identity: its `in` and name (a header name lowercased), or, for an entry that
 * cannot be read, its own pointer. Compared structurally with `Equal.equals`.
 */
type ParameterKey = { readonly in: string; readonly name: string } | { readonly unreadable: string }

interface ParameterEntry {
	readonly key: ParameterKey
	readonly level: Level
	readonly pointer: string
}

/**
 * A parameter's identity, read from the document of the set its reference chain ends in.
 */
const parameterKey = (resolution: Resolution, pointer: string): ParameterKey => {
	const target = follow(resolution, { document: resolution.document, pointer })
	const identity = nodeOption(resolution, target).pipe(
		Option.flatMap((node) => Result.getSuccess(parameterIdentity(node)))
	)

	return Option.match(identity, {
		onNone: () => ({ unreadable: pointer }),
		onSome: (found) => ({
			in: found.in,
			name: found.in === "header" ? Str.toLowerCase(found.name) : found.name
		})
	})
}

/**
 * The entries of an owner's `parameters`, none when it declares none.
 */
const entriesOf = (
	resolution: Resolution,
	owner: string,
	list: Option.Option<ReadonlyArray<unknown>>,
	level: Level
): readonly ParameterEntry[] =>
	Option.match(list, {
		onNone: () => [],
		onSome: (entries) =>
			Arr.map(entries, (_entry, index) => {
				const pointer = childPointer(childPointer(owner, "parameters"), String(index))

				return { key: parameterKey(resolution, pointer), level, pointer }
			})
	})

interface Merged {
	readonly entries: readonly ParameterEntry[]
	readonly overridden: boolean
}

/**
 * Path item entries in document order, an operation entry with the same key replacing its path
 * item entry in place, and the operation's other entries after them (design 2.2, SR:G3).
 */
const mergeEntries = (
	itemEntries: readonly ParameterEntry[],
	operationEntries: readonly ParameterEntry[]
): Merged =>
	Arr.reduce(
		operationEntries,
		{ entries: itemEntries, overridden: false },
		(merged: Merged, entry): Merged =>
			Option.match(
				Arr.findFirstIndex(merged.entries, (existing) => Equal.equals(existing.key, entry.key)),
				{
					onNone: () => ({
						entries: Arr.append(merged.entries, entry),
						overridden: merged.overridden
					}),
					onSome: (index) => ({
						entries: Arr.map(merged.entries, (each, at) => (at === index ? entry : each)),
						overridden:
							merged.overridden ||
							Option.exists(
								Arr.get(merged.entries, index),
								(existing) => existing.level === "pathItem"
							)
					})
				}
			)
	)

interface Assembled {
	readonly diagnostics: readonly Diagnostic[]
	readonly parameters: readonly Parameter[]
	readonly refusedRequired: readonly string[]
}

interface Shared {
	readonly cache: Map<string, ParameterOutcome>
	readonly checkFindings: readonly Diagnostic[]
	readonly context: ServersContext
	readonly resolution: Resolution
	/**
	 * The document root's `servers`, which every operation inherits where nothing nearer overrides them.
	 */
	readonly rootServers: Option.Option<Json>
	readonly schemes: SchemeNormalization
}

const operationInfo = (raw: RawOperation): DiagnosticOperation =>
	Option.match(raw.fields.operationId, {
		onNone: () => ({ method: raw.method, path: raw.path }),
		onSome: (operationId) => ({ method: raw.method, operationId, path: raw.path })
	})

/**
 * A 3.2 `querystring` parameter's form content takes Encoding Objects as for bodies (design 6.1):
 * the body form rules decide them, and the parameter carries the rules, or is refused with their
 * diagnostics when they refuse the content, as a form body alternative would be dropped.
 */
const withFormRules = Effect.fnUntraced(function* withFormRules(
	shared: Shared,
	site: ParameterSite,
	outcome: ParameterOutcome
): Effect.fn.Return<ParameterOutcome, BodyNotReadable> {
	if (
		!ParameterOutcome.$is("Implemented")(outcome) ||
		outcome.parameter.location !== "querystring"
	) {
		return outcome
	}

	const { parameter } = outcome
	const { serialization } = parameter
	if (serialization.kind !== "content") {
		return outcome
	}

	const { nonStandard, ...placed } = site
	const bodySite: Types.Mutable<BodySite> = placed
	if (nonStandard !== undefined) {
		bodySite.nonStandard = nonStandard
	}

	const decided = yield* formContentRules(shared.resolution, bodySite, serialization.mediaType)
	const diagnostics = [...outcome.diagnostics, ...decided.diagnostics]
	if (FormContentOutcome.$is("Refused")(decided)) {
		return ParameterOutcome.Refused({ diagnostics, required: parameter.required })
	}

	const filled = ContentSerialization.make(
		Struct.evolve(serialization, { encoding: () => decided.encoding })
	)

	return ParameterOutcome.Implemented({
		diagnostics,
		parameter: ParameterEntity.make(Struct.evolve(parameter, { serialization: () => filled }))
	})
})

/**
 * One merged entry's outcome, read through the shared cache: a path item parameter is the item's
 * element, not one operation's, so it is read once.
 */
const parameterOutcome = Effect.fnUntraced(function* parameterOutcome(
	shared: Shared,
	raw: RawOperation,
	entry: ParameterEntry
): Effect.fn.Return<ParameterOutcome, BodyNotReadable | ParameterNotReadable> {
	const site: ParameterSite =
		entry.level === "operation"
			? {
					nonStandard: shared.context.config.nonStandard,
					openapi: shared.context.openapi,
					operation: operationInfo(raw),
					pointer: entry.pointer
				}
			: {
					nonStandard: shared.context.config.nonStandard,
					openapi: shared.context.openapi,
					pointer: entry.pointer
				}
	const cached = shared.cache.get(entry.pointer)
	if (cached !== undefined) {
		return cached
	}

	const normalized = yield* normalizeParameter(shared.resolution, site)
	const outcome = yield* withFormRules(shared, site, normalized)
	shared.cache.set(entry.pointer, outcome)

	return outcome
})

const assembleParameters = Effect.fnUntraced(function* assembleParameters(
	shared: Shared,
	raw: RawOperation,
	merged: Merged
): Effect.fn.Return<Assembled, BodyNotReadable | ParameterNotReadable> {
	const outcomes = yield* Effect.forEach(merged.entries, (entry) =>
		parameterOutcome(shared, raw, entry)
	)
	const read = Arr.zip(merged.entries, outcomes)

	return {
		diagnostics: Arr.flatMap(outcomes, (outcome) => outcome.diagnostics),
		parameters: Arr.flatMap(outcomes, (outcome) =>
			ParameterOutcome.$is("Implemented")(outcome) ? [outcome.parameter] : []
		),
		refusedRequired: Arr.flatMap(read, ([entry, outcome]) =>
			ParameterOutcome.$is("Refused")(outcome) && outcome.required ? [entry.pointer] : []
		)
	}
})

interface BodyResult {
	readonly body: Option.Option<Body>
	readonly diagnostics: readonly Diagnostic[]
	readonly refusedRequired: boolean
}

const diagnose = (
	shared: Shared,
	code: Code,
	site: { readonly operation: DiagnosticOperation; readonly pointer: string },
	related: readonly string[]
): Effect.Effect<Diagnostic> => {
	const rule: Rule = rules[code]

	return makeDiagnostic({
		code,
		document: shared.resolution.document,
		element: rule.element,
		hint: rule.hint,
		message: rule.message,
		openapi: shared.context.openapi,
		operation: site.operation,
		pointer: site.pointer,
		related:
			related.length > 0
				? Arr.map(related, (pointer) => ({ document: shared.resolution.document, pointer }))
				: undefined,
		scope: rule.scope,
		severity: rule.severity,
		specSection: specSectionUrl(shared.resolution.line, rule.anchor)
	})
}

const assembleBody = Effect.fnUntraced(function* assembleBody(
	shared: Shared,
	raw: RawOperation
): Effect.fn.Return<BodyResult, BodyNotReadable> {
	if (Option.isNone(raw.fields.requestBody)) {
		return { body: Option.none(), diagnostics: [], refusedRequired: false }
	}

	const pointer = childPointer(raw.pointer, "requestBody")
	const operation = operationInfo(raw)
	if (bodylessMethods.has(raw.method) && shared.resolution.line === "3.0") {
		const ignored = yield* diagnose(shared, "OPR-10/body-ignored", { operation, pointer }, [])

		return { body: Option.none(), diagnostics: [ignored], refusedRequired: false }
	}

	/**
	 * The author config's bracket switch reaches the body as it reaches the parameters.
	 */
	const { nonStandard } = shared.context.config
	const site: Types.Mutable<BodySite> = { openapi: shared.context.openapi, operation, pointer }
	if (nonStandard !== undefined) {
		site.nonStandard = nonStandard
	}

	const outcome = yield* normalizeBody(shared.resolution, site)
	if (BodyOutcome.$is("Refused")(outcome)) {
		return {
			body: Option.none(),
			diagnostics: outcome.diagnostics,
			refusedRequired: outcome.required
		}
	}

	const hinted = yield* hintDiscriminators(shared.resolution, outcome.body, shared.checkFindings)

	return { body: Option.some(hinted), diagnostics: outcome.diagnostics, refusedRequired: false }
})

/**
 * The `servers` of the level whose reference tokens are `tokens`.
 */
const serverSource = (tokens: ReadonlyArray<string>, value: Option.Option<Json>): ServerSource => ({
	pointer: formatPointer([...tokens, "servers"]),
	value
})

const effectiveServersOf = (
	shared: Shared,
	raw: RawOperation
): { readonly diagnostics: readonly Diagnostic[]; readonly servers: readonly Server[] } =>
	effectiveServers(
		{
			operation: serverSource(raw.tokens, raw.fields.servers),
			pathItem: serverSource(raw.item.tokens, raw.item.servers),
			root: serverSource([], shared.rootServers)
		},
		shared.context
	)

const docsOf = (fields: OperationFields): Operation["docs"] => ({
	...Option.match(fields.description, {
		onNone: () => ({}),
		onSome: (description) => ({ description: stripUnsafeText(description) })
	}),
	...Option.match(fields.summary, {
		onNone: () => ({}),
		onSome: (summary) => ({ summary: stripUnsafeText(summary) })
	})
})

/**
 * A row an operation records only when what it stands for is there.
 */
const rowWhen = (present: boolean, row: RowId): ReadonlyArray<RowId> => (present ? [row] : [])

const rowsOf = (
	shared: Shared,
	raw: RawOperation,
	merged: Merged,
	built: { readonly body: Option.Option<Body>; readonly declared: boolean }
): ReadonlyArray<RowId> => {
	const keptBody = Option.isSome(built.body) && bodylessMethods.has(raw.method)
	const rows: ReadonlyArray<RowId> = [
		"OPR-01",
		"OPR-12",
		raw.additional ? "PTH-23" : (methodRows.get(raw.method) ?? "PTH-23"),
		...rowWhen(Option.isSome(raw.fields.operationId), "OPR-06"),
		...rowWhen(Option.isSome(raw.fields.deprecated), "OPR-14"),
		...rowWhen(Option.isSome(raw.fields.parameters), "OPR-08"),
		...rowWhen(
			Arr.some(merged.entries, (entry) => entry.level === "pathItem"),
			"PTH-26"
		),
		...rowWhen(merged.overridden, "PTH-27"),
		...rowWhen(Option.isSome(built.body), "OPR-09"),
		...rowWhen(keptBody && shared.resolution.line !== "3.0", "OPR-11"),
		...rowWhen(built.declared, "OPR-15")
	]

	return Arr.sort(Arr.dedupe(rows), Order.String)
}

type NamingCode = "EXT-01/alias-unnamed" | "EXT-01/naming-invalid"

interface NamingNotice {
	readonly code: NamingCode
	readonly pointer: string
}

interface NamingRead<A> {
	readonly notices: readonly NamingNotice[]
	readonly value: Option.Option<A>
}

/**
 * The keys each source names a group and a method by (design 4.4 Naming extensions).
 */
const namingKeys = {
	fern: { group: "x-fern-sdk-group-name", method: "x-fern-sdk-method-name" },
	forge: { group: "x-forge-group-name", method: "x-forge-method-name" }
} as const

const aliasesKey = "x-forge-aliases"

/**
 * A dotted group, split at `.`.
 */
const dottedGroup: Read.Reader<ReadonlyArray<string>> = (value) =>
	Result.map(Read.string(value), (text) => Str.split(text, "."))

/**
 * A group is a dotted string, split at `.`, or an array whose elements are kept whole; no segment
 * may be empty. Any other shape is unusable.
 */
const groupSegments = (value: Json): Option.Option<Arr.NonEmptyReadonlyArray<string>> =>
	Result.getSuccess(Read.union([dottedGroup, Read.array(Read.string)])(value)).pipe(
		Option.filter(Arr.isReadonlyArrayNonEmpty),
		Option.filter((segments) => Arr.every(segments, (segment) => segment !== ""))
	)

const methodName: Read.Reader<string> = Read.refine(
	Read.string,
	isNonEmptyText,
	"a non-empty string"
)

const invalid = (pointer: string): NamingNotice => ({ code: "EXT-01/naming-invalid", pointer })

/**
 * One source's hint from the object at `pointer`; a present key with an unusable value is dropped
 * with a notice at that key.
 */
const hintOf = (
	holder: JsonObject,
	pointer: JsonPointer,
	source: keyof typeof namingKeys
): NamingRead<typeof NamingHint.Type> => {
	const keys = namingKeys[source]
	const read = <A>(key: string, parse: (value: Json) => Option.Option<A>): NamingRead<A> =>
		Option.match(Record.get(holder, key), {
			onNone: () => ({ notices: [], value: Option.none() }),
			onSome: (value) => {
				const parsed = parse(value)

				return {
					notices: Option.isNone(parsed) ? [invalid(childPointer(pointer, key))] : [],
					value: parsed
				}
			}
		})
	const group = read(keys.group, groupSegments)
	const method = read(keys.method, (value) => Result.getSuccess(methodName(value)))
	const notices = [...group.notices, ...method.notices]
	if (Option.isNone(group.value) && Option.isNone(method.value)) {
		return { notices, value: Option.none() }
	}

	return {
		notices,
		value: Option.some({
			...(Option.isSome(group.value) ? { group: group.value.value } : {}),
			...(Option.isSome(method.value) ? { method: method.value.value } : {}),
			pointer
		})
	}
}

/**
 * An alias names a command by its own keys only: it is usable when its Forge keys, else its Fern
 * keys, give both a group and a method, or else when it has its own `operationId`. It never takes
 * the operation's `operationId`. An `x-forge-aliases` inside it is not read.
 */
const aliasOf = (
	element: Json,
	pointer: JsonPointer,
	index: number
): NamingRead<typeof NamingAlias.Type> => {
	if (!isObject(element)) {
		return { notices: [invalid(pointer)], value: Option.none() }
	}

	const forge = hintOf(element, pointer, "forge")
	const fern = hintOf(element, pointer, "fern")
	const hints = [...Option.toArray(forge.value), ...Option.toArray(fern.value)]
	const named =
		Arr.some(hints, (hint) => hint.group !== undefined) &&
		Arr.some(hints, (hint) => hint.method !== undefined)
	const rawId = Record.get(element, "operationId")
	const operationId = Option.flatMap(rawId, (value) => Result.getSuccess(methodName(value)))
	const notices = [
		...forge.notices,
		...fern.notices,
		...(Option.isSome(rawId) && Option.isNone(operationId)
			? [invalid(childPointer(pointer, "operationId"))]
			: [])
	]

	if (!named && Option.isNone(operationId)) {
		return {
			notices: [...notices, { code: "EXT-01/alias-unnamed", pointer }],
			value: Option.none()
		}
	}

	return {
		notices,
		value: Option.some({
			...(Option.isSome(fern.value) ? { fern: fern.value.value } : {}),
			...(Option.isSome(forge.value) ? { forge: forge.value.value } : {}),
			index,
			...(Option.isSome(operationId) ? { operationId: operationId.value } : {})
		})
	}
}

/**
 * `x-forge-aliases` of the object whose reference tokens are `tokens` must be an array holding at least one usable
 * alias; otherwise it is treated as absent with one notice at the array.
 */
const aliasesOf = (
	holder: JsonObject,
	tokens: ReadonlyArray<string>
): NamingRead<Arr.NonEmptyReadonlyArray<typeof NamingAlias.Type>> =>
	Option.match(Record.get(holder, aliasesKey), {
		onNone: () => ({ notices: [], value: Option.none() }),
		onSome: (value) => {
			const arrayPointer = formatPointer([...tokens, aliasesKey])
			const read = isArray(value)
				? Arr.map(value, (element, index) =>
						aliasOf(element, formatPointer([...tokens, aliasesKey, String(index)]), index)
					)
				: []
			const notices = Arr.flatMap(read, (one) => one.notices)
			const aliases = Arr.getSomes(Arr.map(read, (one) => one.value))

			return Arr.isReadonlyArrayNonEmpty(aliases)
				? { notices, value: Option.some(aliases) }
				: { notices: [invalid(arrayPointer), ...notices], value: Option.none() }
		}
	})

/**
 * The naming extensions of an Operation Object (design 4.4, D-NAME4). Only the five naming keys
 * are read; every extension stays recorded as EXT-01 by `collectInformational`.
 */
const namingOf = (raw: RawOperation): NamingRead<typeof Naming.Type> => {
	const forge = hintOf(raw.node, raw.pointer, "forge")
	const fern = hintOf(raw.node, raw.pointer, "fern")
	const aliases = aliasesOf(raw.node, raw.tokens)
	const notices = [...forge.notices, ...fern.notices, ...aliases.notices]
	if (Option.isNone(aliases.value) && Option.isNone(fern.value) && Option.isNone(forge.value)) {
		return { notices, value: Option.none() }
	}

	return {
		notices,
		value: Option.some({
			...(Option.isSome(aliases.value) ? { aliases: aliases.value.value } : {}),
			...(Option.isSome(fern.value) ? { fern: fern.value.value } : {}),
			...(Option.isSome(forge.value) ? { forge: forge.value.value } : {})
		})
	}
}

interface Assembly {
	readonly diagnostics: readonly Diagnostic[]
	readonly operation: Option.Option<Operation>
}

/**
 * An operation refused whole sends nothing, so none of its elements is sent in the bracket
 * convention or as a scalar pair: their notices go with it (design 8.5 rule 7, option A), as a
 * refused form alternative's do in the body assembly. `nonStandard` reads generated operations only.
 */
const withoutAuthorChoiceNotices = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
	Arr.filter(diagnostics, (diagnostic) => !authorChoiceCodes.has(diagnostic.code))

const assembleOne = Effect.fnUntraced(function* assembleOne(
	shared: Shared,
	raw: RawOperation
): Effect.fn.Return<Assembly, OperationsError> {
	const { resolution } = shared
	const merged = mergeEntries(
		entriesOf(resolution, raw.item.pointer, raw.item.parameters, "pathItem"),
		entriesOf(resolution, raw.pointer, raw.fields.parameters, "operation")
	)
	const parameters = yield* assembleParameters(shared, raw, merged)
	const body = yield* assembleBody(shared, raw)
	const responses = yield* normalizeResponses(
		resolution,
		childPointer(raw.pointer, "responses"),
		operationInfo(raw)
	)
	const policy = yield* normalizeSecurityPolicy(resolution, shared.schemes, Option.some(raw.tokens))
	const servers = effectiveServersOf(shared, raw)
	const site = { operation: operationInfo(raw), pointer: raw.pointer }
	const naming = namingOf(raw)
	const namingNotices = yield* Effect.forEach(naming.notices, (found) =>
		diagnose(shared, found.code, { operation: site.operation, pointer: found.pointer }, [])
	)
	const raises = [
		...(parameters.refusedRequired.length === 0
			? []
			: [
					yield* diagnose(
						shared,
						"OPR-08/required-parameter-refused",
						site,
						parameters.refusedRequired
					)
				]),
		...(body.refusedRequired
			? [
					yield* diagnose(shared, "OPR-09/required-body-refused", site, [
						childPointer(raw.pointer, "requestBody")
					])
				]
			: []),
		...(policy.listed > 0 && policy.policy.alternatives.length === 0
			? [
					yield* diagnose(shared, "SEC-06/no-satisfiable-alternative", site, [
						policy.policy.origin.pointer
					])
				]
			: [])
	]
	const diagnostics = [
		...parameters.diagnostics,
		...body.diagnostics,
		...responses.diagnostics,
		...policy.diagnostics,
		...servers.diagnostics,
		...namingNotices,
		...raises
	]
	if (
		raises.length > 0 ||
		Arr.some(responses.diagnostics, (diagnostic) => diagnostic.scope === "operation")
	) {
		return { diagnostics: withoutAuthorChoiceNotices(diagnostics), operation: Option.none() }
	}

	const operationId = Option.filter(raw.fields.operationId, isNonEmptyText)
	const operation = yield* Schema.decodeEffect(Operation)({
		...(Option.isSome(body.body) ? { body: body.body.value } : {}),
		deprecated: Option.getOrElse(raw.fields.deprecated, () => false),
		docs: docsOf(raw.fields),
		key: { method: raw.method, path: raw.path },
		...(Option.isSome(naming.value) ? { naming: naming.value.value } : {}),
		...(Option.isSome(operationId) ? { operationId: operationId.value } : {}),
		origin: { document: resolution.document, pointer: raw.pointer },
		parameters: parameters.parameters,
		responses: responses.responses,
		rows: rowsOf(shared, raw, merged, { body: body.body, declared: policy.policy.declared }),
		security: policy.policy,
		servers: servers.servers,
		tags: Option.match(raw.fields.tags, {
			onNone: () => [],
			onSome: (tags) => Arr.map(tags, stripUnsafeText)
		})
	}).pipe(Effect.orDie)

	return { diagnostics, operation: Option.some(operation) }
})

/**
 * A diagnostic's identity for `distinctDiagnostics`: a fresh array, hashed and compared element by
 * element.
 */
const identityKey = (diagnostic: Diagnostic) => [
	diagnostic.code,
	diagnostic.document,
	diagnostic.pointer,
	diagnostic.operation?.method,
	diagnostic.operation?.path,
	Arr.map(diagnostic.related ?? [], (site) => [site.document, site.pointer])
]

/**
 * Drops repeated diagnostics (same code, document, pointer, operation and related sites), keeping
 * the first of each in order. Root servers, root security and path item parameters are read once
 * per operation that inherits them, and report once. Each identity is looked up in a hash set of
 * those already kept, so a document with thousands of diagnostics costs one pass, not a comparison
 * of every pair.
 */
export const distinctDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => {
	const kept: Diagnostic[] = []
	let seen = HashSet.empty<ReturnType<typeof identityKey>>()
	for (const diagnostic of diagnostics) {
		const identity = identityKey(diagnostic)
		if (!HashSet.has(seen, identity)) {
			seen = HashSet.add(seen, identity)
			kept.push(diagnostic)
		}
	}

	return kept
}

/**
 * Assembles the operations of the entry document in canonical order (design 2.2, 2.4, 3.7, 6.3).
 * Each keeps its method token and path template, the path item's parameters merged with its own
 * (override by name and `in`, a header name case-insensitively), and the effective servers and
 * security. A body on GET, HEAD, DELETE, OPTIONS or TRACE follows the line: 3.0 ignores it with a
 * notice, 3.1 and later send it on DELETE and OPTIONS and refuse it on GET, HEAD and TRACE at
 * element scope. An operation is removed with an operation-scope refusal when a required parameter
 * or a required body is refused, or when every listed security alternative is refused (`[]` and a
 * remaining `{}` alternative are not). A path or method key the check stage refused is not read. A
 * site the earlier stages should have stopped fails as in the stage that reads it. `checkFindings`
 * are the spec-text check findings of the run: a body discriminator they refuse gets no hint.
 */
export const assembleOperations = Effect.fnUntraced(function* assembleOperations(
	resolution: Resolution,
	schemes: SchemeNormalization,
	context: ServersContext,
	checkFindings: readonly Diagnostic[]
): Effect.fn.Return<OperationAssembly, OperationsError> {
	const root = rootOf(resolution.value)
	const shared: Shared = {
		cache: new Map(),
		checkFindings,
		context,
		resolution,
		rootServers: Option.flatMap(root, (read) => read.servers),
		schemes
	}
	const assembled = yield* Effect.forEach(rawOperations(resolution, root), (raw) =>
		assembleOne(shared, raw)
	)

	return {
		diagnostics: distinctDiagnostics(Arr.flatMap(assembled, (one) => one.diagnostics)),
		operations: Arr.getSomes(Arr.map(assembled, (one) => one.operation))
	}
})
