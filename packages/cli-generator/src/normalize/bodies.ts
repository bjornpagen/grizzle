import { regex } from "arkregex"
import {
	Array as Arr,
	Data,
	Effect,
	Match,
	Option,
	Order,
	pipe,
	Predicate,
	Record,
	Result,
	String as Str,
	Struct,
	UndefinedOr
} from "effect"
import {
	fixedMediaRange,
	isHeaderName,
	isMediaRange,
	isWireName,
	stripUnsafeText
} from "#model/brands.ts"
import type { HeaderName, MediaRange, WireName } from "#model/brands.ts"
import { makeDiagnostic } from "#model/diagnostic.ts"
import type { Diagnostic, DiagnosticOperation } from "#model/diagnostic.ts"
import type {
	Body,
	DiscriminatorHint,
	EncodingRule,
	Origin,
	RowId,
	StyleName
} from "#model/entities.ts"
import { childPointer, formatPointer, isPointerWithin } from "#model/pointer.ts"
import { specSectionUrl } from "#model/spec-section.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { docsOf } from "#normalize/docs.ts"
import {
	childKey,
	follow,
	nodeIn,
	nodeOption,
	originOf,
	referenceIn,
	settle
} from "#normalize/document-set.ts"
import { headerMarks } from "#normalize/header-object.ts"
import {
	authorChoiceCodes,
	bracketChoiceCode,
	compound,
	deepObjectExplodeText,
	formStyleRefusal,
	isStyleName,
	partHeader,
	PartHeaderOutcome,
	scalarChoiceCode,
	scalarCover,
	typeNames
} from "#normalize/parameters.ts"
import type { ScalarCover } from "#normalize/parameters.ts"
import { appliesDynamicKeyword, schemaKeyAt } from "#normalize/schemas.ts"
import { keyOf } from "#resolve/canonical.ts"
import type { CanonicalKey } from "#resolve/canonical.ts"
import { allOfReferrers, implicitComponent } from "#resolve/index.ts"
import type { Resolution, ResolvedReference } from "#resolve/index.ts"
import * as Read from "#runtime-src/runtime/read.ts"
import { mediaEssence } from "#runtime-src/runtime/sequential.ts"

/**
 * Where a request body is read: its use site in the entry document, the operation it belongs to
 * when known, and the document's full `openapi` value. `nonStandard` carries the author config's
 * opt-in switches of the same name; absent is strict (design 6.1, D-OQ1).
 */
export interface BodySite {
	readonly nonStandard?: {
		readonly deepObjectBrackets?: boolean
		readonly deepObjectScalars?: boolean
	}
	readonly openapi: string
	readonly operation?: DiagnosticOperation
	readonly pointer: string
}

/**
 * What normalizing one Request Body Object produced. `Implemented` keeps every alternative that
 * survived; `Refused` means none did, and keeps `required` so the operation assembly can raise the
 * refusal to operation scope.
 */
export type BodyOutcome = Data.TaggedEnum<{
	Implemented: { readonly body: Body; readonly diagnostics: readonly Diagnostic[] }
	Refused: { readonly diagnostics: readonly Diagnostic[]; readonly required: boolean }
}>

/**
 * Constructors and dispatch for {@link BodyOutcome}.
 */
export const BodyOutcome = Data.taggedEnum<BodyOutcome>()

/**
 * The site is not a Request Body Object the earlier stages could have passed: validation or
 * resolution should have stopped it.
 */
export class BodyNotReadable extends Data.TaggedError("BodyNotReadable")<{
	readonly pointer: string
	readonly reason: "media-type-not-an-object" | "not-a-request-body"
}> {}

/**
 * An optional member of a node read by `reader`, as the node types below hold it: `undefined` when
 * the member is absent.
 */
const optional = <A>(
	object: Read.Members,
	name: string,
	reader: Read.Reader<A>
): Result.Result<A | undefined, Read.ReadIssues> =>
	Result.map(Read.optionalMember(object, name, reader), Option.getOrUndefined)

/**
 * What the part rules read of a part header: nothing but that it is an object whose `required`,
 * when present, is a boolean.
 */
interface HeaderNode {
	readonly required: boolean | undefined
}

const headerObject: Read.Reader<HeaderNode> = (value) =>
	Result.flatMap(Read.members(value), (object) =>
		Read.struct(object, { required: optional(object, "required", Read.boolean) }, Read.anything)
	)

interface EncodingNode {
	readonly allowReserved: boolean | undefined
	readonly contentType: string | undefined
	readonly encoding: Readonly<Record<string, EncodingNode>> | undefined
	readonly explode: boolean | undefined
	readonly headers: Readonly<Record<string, HeaderNode>> | undefined
	readonly itemEncoding: EncodingNode | undefined
	readonly prefixEncoding: ReadonlyArray<EncodingNode> | undefined
	readonly style: StyleName | undefined
}

/**
 * An Encoding Object, each member it does not name ignored. Encoding Objects nest, so the reader
 * is recursive; the rules cap the depth at one level.
 */
const encodingObject: Read.Reader<EncodingNode> = (value) =>
	Result.flatMap(Read.members(value), (object) =>
		Read.struct(
			object,
			{
				allowReserved: optional(object, "allowReserved", Read.boolean),
				contentType: optional(object, "contentType", Read.string),
				encoding: optional(object, "encoding", Read.record(Read.string, encodingObject)),
				explode: optional(object, "explode", Read.boolean),
				headers: optional(object, "headers", Read.record(Read.string, headerObject)),
				itemEncoding: optional(object, "itemEncoding", encodingObject),
				prefixEncoding: optional(object, "prefixEncoding", Read.array(encodingObject)),
				style: optional(object, "style", Read.refine(Read.string, isStyleName, "a style name"))
			},
			Read.anything
		)
	)

/**
 * The Encoding Object of a part that declares none.
 */
const noEncoding: EncodingNode = {
	allowReserved: undefined,
	contentType: undefined,
	encoding: undefined,
	explode: undefined,
	headers: undefined,
	itemEncoding: undefined,
	prefixEncoding: undefined,
	style: undefined
}

interface RequestBodyNode {
	readonly content: Read.Members
	readonly description: string | undefined
	readonly required: boolean | undefined
}

const requestBodyObject: Read.Reader<RequestBodyNode> = (value) =>
	Result.flatMap(Read.members(value), (object) =>
		Read.struct(
			object,
			{
				content: Read.member(object, "content", Read.members),
				description: optional(object, "description", Read.string),
				required: optional(object, "required", Read.boolean)
			},
			Read.anything
		)
	)

interface MediaNode {
	readonly description: string | undefined
	readonly encoding: Readonly<Record<string, EncodingNode>> | undefined
	readonly itemEncoding: EncodingNode | undefined
	readonly itemSchema: unknown
	readonly prefixEncoding: ReadonlyArray<EncodingNode> | undefined
	readonly schema: unknown
}

const mediaTypeObject: Read.Reader<MediaNode> = (value) =>
	Result.flatMap(Read.members(value), (object) =>
		Read.struct(
			object,
			{
				description: optional(object, "description", Read.string),
				encoding: optional(object, "encoding", Read.record(Read.string, encodingObject)),
				itemEncoding: optional(object, "itemEncoding", encodingObject),
				itemSchema: optional(object, "itemSchema", Read.anything),
				prefixEncoding: optional(object, "prefixEncoding", Read.array(encodingObject)),
				schema: optional(object, "schema", Read.anything)
			},
			Read.anything
		)
	)

/**
 * Only what the part rules read of a schema; a boolean schema reads as `noSchemaNode`. `required`
 * and the compositions are any value so a malformed one never hides the node's other members.
 */
interface SchemaNodeValue {
	readonly additionalProperties: unknown
	readonly allOf: ReadonlyArray<unknown> | undefined
	readonly anyOf: unknown
	readonly contentEncoding: string | undefined
	readonly dependentRequired: unknown
	readonly dependentSchemas: unknown
	readonly format: string | undefined
	readonly if: unknown
	readonly items: unknown
	readonly not: unknown
	readonly oneOf: unknown
	readonly prefixItems: ReadonlyArray<unknown> | undefined
	readonly properties: Read.Members | undefined
	readonly required: unknown
	readonly type: string | ReadonlyArray<string> | undefined
}

const schemaObject: Read.Reader<SchemaNodeValue> = (value) =>
	Result.flatMap(Read.members(value), (object) =>
		Read.struct(
			object,
			{
				additionalProperties: optional(object, "additionalProperties", Read.anything),
				allOf: optional(object, "allOf", Read.array(Read.anything)),
				anyOf: optional(object, "anyOf", Read.anything),
				contentEncoding: optional(object, "contentEncoding", Read.string),
				dependentRequired: optional(object, "dependentRequired", Read.anything),
				dependentSchemas: optional(object, "dependentSchemas", Read.anything),
				format: optional(object, "format", Read.string),
				if: optional(object, "if", Read.anything),
				items: optional(object, "items", Read.anything),
				not: optional(object, "not", Read.anything),
				oneOf: optional(object, "oneOf", Read.anything),
				prefixItems: optional(object, "prefixItems", Read.array(Read.anything)),
				properties: optional(object, "properties", Read.members),
				required: optional(object, "required", Read.anything),
				type: optional(object, "type", Read.union([Read.string, Read.array(Read.string)]))
			},
			Read.anything
		)
	)

/**
 * The schema node a node that is no readable schema object reads as: it declares nothing.
 */
const noSchemaNode: SchemaNodeValue = {
	additionalProperties: undefined,
	allOf: undefined,
	anyOf: undefined,
	contentEncoding: undefined,
	dependentRequired: undefined,
	dependentSchemas: undefined,
	format: undefined,
	if: undefined,
	items: undefined,
	not: undefined,
	oneOf: undefined,
	prefixItems: undefined,
	properties: undefined,
	required: undefined,
	type: undefined
}

const formUrlencoded = "application/x-www-form-urlencoded"

/**
 * The part types the encoding table defaults to (ENC-17 to ENC-26), `text/plain` also the type of
 * a form-pairs part (ENC-40).
 */
const octetStream = fixedMediaRange("application/octet-stream")

const textPlain = fixedMediaRange("text/plain")

const applicationJson = fixedMediaRange("application/json")

type Codec =
	| "binary"
	| "form"
	| "json"
	| "jsonseq"
	| "multipart"
	| "ndjson"
	| "sse"
	| "text"
	| "xml"

const ndjsonTypes: ReadonlySet<string> = new Set([
	"application/jsonl",
	"application/ndjson",
	"application/x-ndjson"
])

/**
 * The codec follows the media type alone (design 2.2); a media range is raw bytes until the operator
 * names a concrete type. It differs from the response codec on `text/*` and `+json-seq` by design.
 */
const codecOf = (base: string): Codec => {
	if (base === formUrlencoded) {
		return "form"
	}

	if (Str.startsWith("multipart/")(base)) {
		return "multipart"
	}

	if (base === "text/event-stream") {
		return "sse"
	}

	if (base === "application/json-seq" || Str.endsWith("+json-seq")(base)) {
		return "jsonseq"
	}

	if (ndjsonTypes.has(base)) {
		return "ndjson"
	}

	if (base === "application/json" || Str.endsWith("+json")(base)) {
		return "json"
	}

	if (base === "application/xml" || base === "text/xml" || Str.endsWith("+xml")(base)) {
		return "xml"
	}

	return Str.startsWith("text/")(base) ? "text" : "binary"
}

interface Finding {
	readonly anchor: string
	readonly code: string
	/**
	 * The refusal drops its whole media alternative; `anchorDrops` moves it to the media type.
	 */
	readonly drops?: true
	readonly element: string
	readonly hint?: string
	readonly message: string
	readonly at: CanonicalKey
	readonly related?: readonly CanonicalKey[]
	/**
	 * `field`: one property of a kept alternative is refused (design 8.5); absent, `element`.
	 */
	readonly scope?: "field"
	readonly severity: "notice" | "refusal"
	/**
	 * The refused property's wire name, set with `field` scope only.
	 */
	readonly wire?: string
}

/**
 * A refusal that tells the author what to do instead.
 */
const refusal = (
	code: string,
	anchor: string,
	element: string,
	message: string,
	at: CanonicalKey,
	hint: string
): Finding => ({ anchor, at, code, element, hint, message, severity: "refusal" })

/**
 * A refusal whose message is the whole story.
 */
const plainRefusal = (
	code: string,
	anchor: string,
	element: string,
	message: string,
	at: CanonicalKey
): Finding => ({ anchor, at, code, element, message, severity: "refusal" })

const notice = (
	code: string,
	anchor: string,
	element: string,
	message: string,
	at: CanonicalKey
): Finding => ({ anchor, at, code, element, message, severity: "notice" })

/**
 * A refusal whose part, rule or key leaves its media alternative with nothing to send.
 */
const dropping = (finding: Finding): Finding => ({ ...finding, drops: true })

/**
 * A refusal that drops a whole alternative is reported at that media type, its own keyword first
 * in `related`, so the report names what was dropped and coverage credits it.
 */
const anchorDrops = (home: CanonicalKey, findings: readonly Finding[]): readonly Finding[] =>
	Arr.map(findings, (finding) =>
		finding.drops === true
			? { ...finding, at: home, related: [finding.at, ...(finding.related ?? [])] }
			: finding
	)

/**
 * A dropping refusal of an optional property whose alternative stays is refused at `field` scope,
 * anchored at the property's Encoding entry, its own keyword first in `related` (design 8.5 rule 4),
 * and names the property by `wire`.
 */
const fieldRefusal = (entry: CanonicalKey, finding: Finding, wire: string): Finding => {
	const kept = Struct.omit(finding, ["drops"])
	const field: Finding = { ...kept, at: entry, scope: "field", wire }

	return keyOf(finding.at) === keyOf(entry)
		? field
		: { ...field, related: [finding.at, ...(finding.related ?? [])] }
}

const sorted = (rows: ReadonlyArray<RowId>): ReadonlyArray<RowId> =>
	Arr.sort(Arr.dedupe(rows), Order.String)

interface Located {
	readonly at: CanonicalKey
	readonly node: SchemaNodeValue
}

const nodeAt = (resolution: Resolution, at: CanonicalKey): Effect.Effect<SchemaNodeValue> =>
	nodeIn(resolution, at).pipe(
		Effect.map((json) => Result.getOrElse(schemaObject(json), () => noSchemaNode)),
		Effect.orElseSucceed(() => noSchemaNode)
	)

/**
 * One body's schema inspection: the resolution it reads and the body's use site.
 */
interface Walk {
	readonly resolution: Resolution
	readonly site: BodySite
}

/**
 * The schema and its `allOf` members in document order, each distinct schema once, so a graph
 * that reuses members costs its size and a cycle ends at the first repeat.
 */
const flatten = Effect.fnUntraced(function* flatten(
	walk: Walk,
	start: CanonicalKey
): Effect.fn.Return<readonly Located[]> {
	const seen = new Set<string>()
	const found: Located[] = []
	const pending = [start]
	let next = pending.pop()
	while (next !== undefined) {
		const at = settle(walk.resolution, next)
		if (!seen.has(keyOf(at))) {
			seen.add(keyOf(at))

			const node = yield* nodeAt(walk.resolution, at)
			found.push({ at, node })

			const members = Arr.map(node.allOf ?? [], (_, index) => childKey(at, "allOf", String(index)))
			for (const member of Arr.reverse(members)) {
				pending.push(member)
			}
		}

		next = pending.pop()
	}

	return found
})

const firstLocated = <T>(
	nodes: readonly Located[],
	read: (node: SchemaNodeValue) => T | undefined
): { readonly at: CanonicalKey; readonly value: T } | undefined => {
	for (const located of nodes) {
		const value = read(located.node)
		if (value !== undefined) {
			return { at: located.at, value }
		}
	}

	return undefined
}

interface Members {
	readonly items: CanonicalKey | undefined
	readonly prefixItems: readonly CanonicalKey[]
	readonly properties: readonly (readonly [string, CanonicalKey])[]
}

const noMembers: Members = { items: undefined, prefixItems: [], properties: [] }

/**
 * The declared properties (document order, first definition wins) and item schemas of a schema.
 */
const membersOf = Effect.fnUntraced(function* membersOf(
	walk: Walk,
	schema: CanonicalKey
): Effect.fn.Return<Members> {
	const nodes = yield* flatten(walk, schema)
	const seen = new Set<string>()
	const properties: (readonly [string, CanonicalKey])[] = []
	for (const located of nodes) {
		for (const name of Record.keys(located.node.properties ?? {})) {
			if (!seen.has(name)) {
				seen.add(name)
				properties.push([name, childKey(located.at, "properties", name)])
			}
		}
	}

	const prefix = firstLocated(nodes, (node) => node.prefixItems)
	const items = firstLocated(nodes, (node) => node.items)

	return {
		items: items === undefined || items.value === false ? undefined : childKey(items.at, "items"),
		prefixItems:
			prefix === undefined
				? []
				: Arr.map(prefix.value, (_, index) => childKey(prefix.at, "prefixItems", String(index))),
		properties
	}
})

const memberSchema = (members: Members, target: Target): CanonicalKey | undefined =>
	target.kind === "property"
		? Option.getOrUndefined(
				Option.map(
					Arr.findFirst(members.properties, ([name]) => name === target.name),
					([, schema]) => schema
				)
			)
		: members.prefixItems[target.index]

/**
 * Which properties of an alternative schema are required (design 8.5 rule 3): `names` gathers every
 * `required` array on the path `membersOf` walks, the root, `$ref` targets and `allOf` members.
 * `sure` is false when that walk cannot be complete: a cycle, a reference it cannot follow, or a
 * composition it does not resolve; then every property counts as required.
 */
interface Requirement {
	readonly names: ReadonlySet<string>
	readonly sure: boolean
}

/**
 * Keywords that can make a property required on a path `membersOf` does not follow; `then` and
 * `else` apply only under `if`.
 */
const unresolved = ["anyOf", "dependentRequired", "dependentSchemas", "if", "not", "oneOf"] as const

/**
 * The property names a schema's `required` lists: none when it is absent or no array of strings.
 */
const requiredNames = (node: SchemaNodeValue): ReadonlyArray<string> =>
	Result.getOrElse(Read.array(Read.string)(node.required), (): ReadonlyArray<string> => [])

const requirementOf = Effect.fnUntraced(function* requirementOf(
	walk: Walk,
	schema: CanonicalKey
): Effect.fn.Return<Requirement> {
	const names = new Set<string>()
	const done = new Set<string>()
	const path = new Set<string>()
	let sure = true
	/**
	 * A schema already on the path is a cycle, and a reference `settle` left unfollowed is not
	 * resolved: either leaves the walk unsure. A schema reached twice otherwise is read once.
	 */
	const visit = Effect.fnUntraced(function* member(start: CanonicalKey): Effect.fn.Return<void> {
		const at = settle(walk.resolution, start)
		const key = keyOf(at)
		if (path.has(key) || referenceIn(walk.resolution, at)?.kind === "schema") {
			sure = false
		} else if (!done.has(key)) {
			done.add(key)

			const node = yield* nodeAt(walk.resolution, at)
			for (const name of requiredNames(node)) {
				names.add(name)
			}

			if (Arr.some(unresolved, (keyword) => node[keyword] !== undefined)) {
				sure = false
			}

			path.add(key)
			for (const index of (node.allOf ?? []).keys()) {
				yield* visit(childKey(at, "allOf", String(index)))
			}

			path.delete(key)
		}
	})

	yield* visit(schema)

	return { names, sure }
})

const isRequired = (requirement: Requirement, name: string): boolean =>
	!requirement.sure || requirement.names.has(name)

interface Facts {
	readonly contentEncoding: { readonly at: CanonicalKey; readonly value: string } | undefined
	readonly format: string | undefined
	readonly items: Facts | undefined
	readonly type: readonly string[]
}

const noFacts: Facts = {
	contentEncoding: undefined,
	format: undefined,
	items: undefined,
	type: []
}

const factsOf = Effect.fnUntraced(function* facts(
	walk: Walk,
	schema: CanonicalKey | undefined,
	depth: number
): Effect.fn.Return<Facts> {
	if (schema === undefined) {
		return noFacts
	}

	const nodes = yield* flatten(walk, schema)
	const items = firstLocated(nodes, (node) => node.items)
	const itemFacts =
		items === undefined || depth > 0
			? undefined
			: yield* factsOf(walk, childKey(items.at, "items"), depth + 1)
	const type = firstLocated(nodes, (node) => node.type)?.value

	return {
		contentEncoding: firstLocated(nodes, (node) => node.contentEncoding),
		format: firstLocated(nodes, (node) => node.format)?.value,
		items: itemFacts,
		type: typeNames(type)
	}
})

interface Default {
	readonly row: RowId
	readonly type: MediaRange
}

const absentDefault = (line: SpecLine): Default => ({
	row: line === "3.0" ? "ENC-26" : "ENC-17",
	type: octetStream
})

const stringDefault = (line: SpecLine, facts: Facts): Default => {
	if (line === "3.0" && (facts.format === "binary" || facts.format === "byte")) {
		return { row: "ENC-18", type: octetStream }
	}

	if (line !== "3.0" && facts.contentEncoding !== undefined) {
		return { row: "ENC-19", type: octetStream }
	}

	return { row: "ENC-20", type: textPlain }
}

const scalarDefault = (line: SpecLine, name: string, facts: Facts): Default =>
	Match.value(name).pipe(
		Match.when("string", (): Default => stringDefault(line, facts)),
		Match.whenOr("number", "integer", "boolean", (): Default => ({
			row: "ENC-21",
			type: textPlain
		})),
		Match.when("object", (): Default => ({ row: "ENC-22", type: applicationJson })),
		Match.when("null", (): Default => ({ row: "ENC-25", type: textPlain })),
		Match.orElse((): Default => absentDefault(line))
	)

type ArrayDefault = (line: SpecLine, facts: Facts) => Default

/**
 * A type list ignores `null` unless it is the only member, and a list whose members disagree is
 * treated as untyped.
 */
const defaultOfTypes = (line: SpecLine, facts: Facts, arrayDefault: ArrayDefault): Default => {
	const named = Arr.filter(facts.type, (name) => name !== "null")
	const names: readonly string[] = named.length === 0 ? facts.type : named
	const decided = Arr.dedupeWith(
		Arr.map(names, (name) =>
			name === "array" ? arrayDefault(line, facts) : scalarDefault(line, name, facts)
		),
		(left: Default, right: Default) => left.type === right.type
	)
	const [only] = decided

	return decided.length === 1 && only !== undefined ? only : absentDefault(line)
}

const nestedArrayDefault: ArrayDefault = () => ({ row: "ENC-23", type: applicationJson })

/**
 * An array is typed by its items (ENC-23), except in 3.2, where an array is `application/json`
 * unless it is a top-level property under encoding by name, which is encoded per item (ENC-24).
 */
const arrayDefault =
	(byName: boolean): ArrayDefault =>
	(line, facts) => {
		const items = defaultOfTypes(line, facts.items ?? noFacts, nestedArrayDefault).type
		if (line !== "3.2") {
			return { row: "ENC-23", type: items }
		}

		return { row: "ENC-24", type: byName ? items : applicationJson }
	}

/**
 * ENC-17 to ENC-26: the default contentType of a part from the schema of its value.
 */
const defaultFor = (line: SpecLine, facts: Facts, input: RuleInput): Default =>
	defaultOfTypes(line, facts, arrayDefault(input.target.kind === "property" && input.depth === 0))

type Target =
	| { readonly kind: "position"; readonly index: number }
	| { readonly kind: "property"; readonly name: WireName }

interface PlainSerialization {
	allowReserved?: boolean
	explode?: boolean
	style?: StyleName
}

interface PlainHeader {
	readonly deprecated: boolean
	readonly name: HeaderName
	readonly required: boolean
	readonly schema: { readonly key: string }
	readonly sensitive?: true
	readonly serialization: Extract<PartHeaderOutcome, { readonly _tag: "Typed" }>["serialization"]
}

interface PlainNested {
	readonly contentType: ReadonlyArray<MediaRange>
	readonly headers: readonly PlainHeader[]
	serialization?: PlainSerialization
	readonly target: Target
}

interface PlainRule extends PlainNested {
	contentEncoding?: "base64"
	nested?: readonly PlainNested[]
	nestedItem?: PlainNested
	nonStandard?: "deepObjectBrackets"
	nonStandardScalars?: "deepObjectScalars"
	readonly origin: Origin
	readonly rows: ReadonlyArray<RowId>
}

interface RuleResult {
	readonly findings: readonly Finding[]
	readonly rule: PlainRule | undefined
}

interface RuleInput {
	readonly actual: CanonicalKey
	readonly depth: 0 | 1
	/**
	 * The part is a top-level part of a `multipart/form-data` body, whose `Content-Disposition` the
	 * writer writes.
	 */
	readonly formData: boolean
	readonly honorsStyle: boolean
	readonly node: EncodingNode | undefined
	readonly schema: CanonicalKey | undefined
	readonly target: Target
}

interface Context {
	readonly line: SpecLine
	readonly reference: ResolvedReference | undefined
	readonly resolution: Resolution
	readonly site: BodySite
	readonly walk: Walk
}

/**
 * A label as a message quotes it: sanitized, then written as a JSON string.
 */
const quoted = (text: string): string => pipe(text, stripUnsafeText, JSON.stringify)

const targetLabel = (target: Target): string =>
	target.kind === "property" ? target.name : `position ${target.index}`

const contentTypes = (text: string): Option.Option<ReadonlyArray<MediaRange>> => {
	const parts = Arr.map(Str.split(text, ","), (part) => Str.trim(part))

	return Arr.every(parts, isMediaRange) ? Option.some(parts) : Option.none()
}

const explicitStyle = (node: EncodingNode): PlainSerialization => {
	const given: PlainSerialization = {}
	if (node.allowReserved !== undefined) {
		given.allowReserved = node.allowReserved
	}

	if (node.explode !== undefined) {
		given.explode = node.explode
	}

	if (node.style !== undefined) {
		given.style = node.style
	}

	return given
}

const styleRows = (style: PlainSerialization): ReadonlyArray<RowId> => [
	...(style.style === undefined ? [] : (["ENC-04"] as const)),
	...(style.explode === undefined ? [] : (["ENC-05"] as const)),
	...(style.allowReserved === undefined ? [] : (["ENC-06"] as const)),
	"ENC-13"
]

/**
 * Whether a style-based `multipart/form-data` part is sent the way the multipart writer sends it
 * (ENC-40, Appendix C): `form` with `explode` gives one name and raw value per value, which is one
 * part per value, under no contentType (RFC 7578: `text/plain`). `allowReserved` has no effect on
 * multipart. Other styles and an unexploded `form` join values into one part, which the writer has
 * no input for.
 */
export const sendsFormPairs = (serialization: {
	readonly explode?: boolean | undefined
	readonly style?: string | undefined
}): boolean =>
	(serialization.style === undefined || serialization.style === "form") &&
	serialization.explode !== false

const unsupportedPartStyleCode = "ENC-40/unsupported-part-style"

const unsupportedPartStyle = (input: RuleInput): Finding =>
	refusal(
		unsupportedPartStyleCode,
		"appendix-c-using-rfc6570-based-serialization",
		"Encoding style, explode or allowReserved",
		`The multipart part ${quoted(targetLabel(input.target))} uses a style that joins its values into one part, which is not supported; the part has no flag.`,
		input.actual,
		"Use style form with explode true, or remove the style fields"
	)

const styleIgnored = (actual: CanonicalKey): Finding =>
	notice(
		"ENC-12/style-ignored",
		"encoding-style",
		"Encoding style, explode or allowReserved",
		"The specification applies these fields to form-urlencoded and multipart/form-data values only, so they are ignored here.",
		actual
	)

const contentTypeIgnored = (actual: CanonicalKey): Finding =>
	notice(
		"ENC-13/content-type-ignored",
		"fixed-fields-for-rfc6570-style-serialization",
		"Encoding contentType beside style fields",
		"An explicit style, explode or allowReserved makes contentType SHALL be ignored.",
		actual
	)

const invalidContentType = (input: RuleInput): Finding =>
	dropping(
		plainRefusal(
			"ENC-02/invalid-content-type",
			"encoding-content-type",
			"Encoding contentType",
			`The contentType of ${quoted(targetLabel(input.target))} is not a list of media ranges.`,
			childKey(input.actual, "contentType")
		)
	)

/**
 * D-SCH3: an object part typed as XML would need serialization from its schema and XML Object,
 * which is refused. A scalar part typed as XML is the operator's own text, sent as given.
 */
const schemaDrivenXml = (input: RuleInput): Finding =>
	dropping(
		refusal(
			"XML-01/schema-driven",
			"xml-object",
			"Multipart part contentType",
			`The multipart part ${quoted(targetLabel(input.target))} is an object typed as XML, which needs serialization from its schema and the XML Object; schema-driven XML is not supported.`,
			childKey(input.actual, "contentType"),
			"Type the part application/json, or make the whole body an XML media type sent from --body-file"
		)
	)

const isXmlType = (range: string): boolean => codecOf(mediaEssence(range)) === "xml"

/**
 * Whether the part's schema is an object: typed `object`, or untyped with declared properties,
 * found through `$ref` and `allOf`.
 */
const isObjectPart = Effect.fnUntraced(function* isObjectPart(
	walk: Walk,
	schema: CanonicalKey | undefined,
	facts: Facts
): Effect.fn.Return<boolean> {
	if (schema === undefined) {
		return false
	}

	if (Arr.contains(facts.type, "object")) {
		return true
	}

	if (facts.type.length > 0) {
		return false
	}

	const members = yield* membersOf(walk, schema)

	return members.properties.length > 0
})

interface Typing {
	readonly contentType: ReadonlyArray<MediaRange>
	readonly findings: readonly Finding[]
	readonly refused: boolean
	readonly rows: ReadonlyArray<RowId>
	readonly serialization: PlainSerialization | undefined
}

/**
 * ENC-02, ENC-12, ENC-13 and the ENC-17 to ENC-26 table: how the part's type is decided.
 */
const typingOf = Effect.fnUntraced(function* typingOf(
	ctx: Context,
	input: RuleInput,
	node: EncodingNode,
	facts: Effect.Effect<Facts>
): Effect.fn.Return<Typing> {
	const given = explicitStyle(node)
	const hasStyle = Struct.keys(given).length > 0
	const findings: Finding[] = []
	if (hasStyle && input.honorsStyle) {
		if (node.contentType !== undefined) {
			findings.push(contentTypeIgnored(input.actual))
		}

		return {
			contentType: [],
			findings,
			refused: false,
			rows: ["ENC-01", ...styleRows(given)],
			serialization: given
		}
	}

	if (hasStyle) {
		findings.push(styleIgnored(input.actual))
	}

	if (node.contentType === undefined) {
		const known = yield* facts
		const fallback = defaultFor(ctx.line, known, input)

		return {
			contentType: [fallback.type],
			findings,
			refused: false,
			rows: ["ENC-01", fallback.row],
			serialization: undefined
		}
	}

	const parsed = contentTypes(node.contentType)
	if (Option.isNone(parsed)) {
		return {
			contentType: [],
			findings: [...findings, invalidContentType(input)],
			refused: true,
			rows: [],
			serialization: undefined
		}
	}

	return {
		contentType: parsed.value,
		findings,
		refused: false,
		rows: ["ENC-01", "ENC-02"],
		serialization: undefined
	}
})

/**
 * A multipart part's typing: as `typingOf`, and an object part typed as XML is refused (XML-01).
 */
const partTypingOf = Effect.fnUntraced(function* partTypingOf(
	ctx: Context,
	input: RuleInput,
	node: EncodingNode,
	facts: Facts
): Effect.fn.Return<Typing> {
	const typing = yield* typingOf(ctx, input, node, Effect.succeed(facts))
	const xml = Arr.some(typing.contentType, isXmlType)
	if (typing.refused || !xml) {
		return typing
	}

	const objectPart = yield* isObjectPart(ctx.walk, input.schema, facts)
	if (!objectPart) {
		return typing
	}

	return {
		...typing,
		contentType: [],
		findings: [...typing.findings, schemaDrivenXml(input)],
		refused: true,
		rows: []
	}
})

interface Headers {
	readonly findings: readonly Finding[]
	readonly headers: readonly PlainHeader[] | undefined
	/**
	 * Whether the rule declares a header besides an ignored `Content-Type` (row ENC-03).
	 */
	readonly declares: boolean
}

const writerOwnedCode = "ENC-03/writer-owned-header"

/**
 * Headers the multipart writer writes itself (design 6.3): `Content-Transfer-Encoding` always, and
 * `Content-Disposition`, with the part name RFC 7578 requires, under `multipart/form-data`.
 */
const writerOwned = (name: string, formData: boolean): boolean => {
	const folded = Str.toLowerCase(name)

	return folded === "content-transfer-encoding" || (formData && folded === "content-disposition")
}

/**
 * ENC-03, ENC-11: part headers, each typed and serialized as a header parameter (HDR-01). A
 * `Content-Type` entry is ignored, a header the writer owns gets no flag, and a bad name or a header
 * the header parameter path cannot carry refuses the part.
 */
const headersOf = Effect.fnUntraced(function* headersOf(
	ctx: Context,
	input: RuleInput,
	node: EncodingNode
): Effect.fn.Return<Headers> {
	const { resolution } = ctx
	const findings: Finding[] = []
	const kept: PlainHeader[] = []
	let declares = false
	for (const name of Record.keys(node.headers ?? {})) {
		const at = childKey(input.actual, "headers", name)
		if (Str.toLowerCase(name) === "content-type") {
			findings.push(
				notice(
					"ENC-11/content-type-header-ignored",
					"encoding-headers",
					"Encoding header Content-Type",
					"The specification says a Content-Type entry in headers SHALL be ignored; the part type comes from contentType.",
					at
				)
			)
			continue
		}

		declares = true
		if (!isHeaderName(name)) {
			findings.push(
				dropping(
					plainRefusal(
						"ENC-03/invalid-header-name",
						"encoding-headers",
						"Encoding header name",
						`The header name ${quoted(name)} is not an HTTP field name.`,
						at
					)
				)
			)

			return { declares, findings, headers: undefined }
		}

		if (writerOwned(name, input.formData)) {
			findings.push(
				notice(
					writerOwnedCode,
					"encoding-headers",
					`Encoding header ${name}`,
					`The multipart writer writes ${name} itself, so the declared header gets no flag and is not sent as declared.`,
					at
				)
			)
			continue
		}

		const origin = yield* originOf(at)
		const typed = partHeader(resolution, at, name, origin)
		if (PartHeaderOutcome.$is("Unsupported")(typed)) {
			findings.push(
				dropping(
					refusal(
						"ENC-03/unsupported-part-header",
						"encoding-headers",
						`Encoding header ${name}`,
						`The part header ${name} cannot be sent as a header parameter: ${typed.reason}`,
						at,
						"Describe the header with a schema the header parameter rules accept, or remove it"
					)
				)
			)

			return { declares, findings, headers: undefined }
		}

		const marks = yield* headerMarks(resolution, at)
		const header: PlainHeader = {
			deprecated: marks.deprecated,
			name,
			required: marks.required,
			schema: typed.schema,
			serialization: typed.serialization
		}
		kept.push(typed.sensitive === true ? { ...header, sensitive: true } : header)
	}

	return { declares, findings, headers: kept }
})

/**
 * ENC-41: a part or a form field goes on the wire under its property's name, so a property or
 * encoding key that is no wire name (empty, or holding a control character; validation refuses a
 * lone surrogate) names nothing the body can send, and its alternative is refused.
 */
const invalidPartName = (name: string, at: CanonicalKey): Finding =>
	dropping(
		plainRefusal(
			"ENC-41/invalid-part-name",
			"media-type-encoding",
			"Part name",
			`The part name ${quoted(name)} is empty or contains control characters or lone surrogates.`,
			at
		)
	)

/**
 * The target of the rule of the property `name`, whose rule sits at `at`: ENC-41 when the name is
 * no wire name.
 */
const namedTarget = (name: string, at: CanonicalKey): Result.Result<Target, Finding> =>
	isWireName(name)
		? Result.succeed({ kind: "property", name })
		: Result.fail(invalidPartName(name, at))

interface NestedEntry {
	readonly actual: CanonicalKey
	readonly node: EncodingNode | undefined
	readonly target: Target
}

const positionalEntries = (node: EncodingNode, actual: CanonicalKey): readonly NestedEntry[] =>
	Arr.map(node.prefixEncoding ?? [], (child, index): NestedEntry => ({
		actual: childKey(actual, "prefixEncoding", String(index)),
		node: child,
		target: { index, kind: "position" }
	}))

/**
 * The nested rules' entries: by name (HT:B16, ENC-07), every property of the part's schema in
 * property order, its Encoding Object or else the default table, then each encoding key that names
 * no property; by position, each `prefixEncoding` entry.
 */
const nestedEntries = (
	node: EncodingNode,
	actual: CanonicalKey,
	members: Members
): Result.Result<ReadonlyArray<NestedEntry>, Finding> => {
	const byName = node.encoding
	const declared = new Set(Arr.map(members.properties, ([name]) => name))
	const properties =
		byName === undefined
			? []
			: Arr.map(members.properties, ([name, schema]) => {
					const explicit = Option.getOrUndefined(Record.get(byName, name))
					const at = explicit === undefined ? schema : childKey(actual, "encoding", name)

					return Result.map(namedTarget(name, at), (target): NestedEntry => ({
						actual: at,
						node: explicit,
						target
					}))
				})
	const undeclared = Arr.map(
		Arr.filter(Record.toEntries(byName ?? {}), ([name]) => !declared.has(name)),
		([name, child]) => {
			const at = childKey(actual, "encoding", name)

			return Result.map(namedTarget(name, at), (target): NestedEntry => ({
				actual: at,
				node: child,
				target
			}))
		}
	)

	return Result.map(Result.all([...properties, ...undeclared]), (named) => [
		...named,
		...positionalEntries(node, actual)
	])
}

const toNested = (rule: PlainRule): PlainNested => {
	const nested: PlainNested = {
		contentType: rule.contentType,
		headers: rule.headers,
		target: rule.target
	}
	if (rule.serialization !== undefined) {
		nested.serialization = rule.serialization
	}

	return nested
}

const nestingRefusal = (
	code: string,
	element: string,
	message: string,
	actual: CanonicalKey
): Finding => dropping(plainRefusal(code, "nested-encoding", element, message, actual))

interface Nesting {
	readonly findings: readonly Finding[]
	/**
	 * The nested `itemEncoding`'s rule, after the nested positions (ENC-09).
	 */
	readonly item: PlainNested | undefined
	readonly nested: readonly PlainNested[]
	readonly refused: boolean
	readonly rows: ReadonlyArray<RowId>
}

const refuseNesting = (finding: Finding): Nesting => ({
	findings: [finding],
	item: undefined,
	nested: [],
	refused: true,
	rows: []
})

interface Batch {
	readonly findings: readonly Finding[]
	readonly refused: boolean
	readonly rules: readonly PlainRule[]
}

type BuildAll = (ctx: Context, inputs: readonly RuleInput[]) => Effect.Effect<Batch>

const nestedRows = (node: EncodingNode): ReadonlyArray<RowId> => [
	...(node.encoding === undefined ? [] : (["ENC-07"] as const)),
	...(node.prefixEncoding === undefined ? [] : (["ENC-08"] as const)),
	...(node.itemEncoding === undefined ? [] : (["ENC-09"] as const))
]

/**
 * ENC-07 to ENC-09, ENC-16: one nested level by name and by position, the nested `itemEncoding`
 * the rule of every position after the nested `prefixEncoding` (HT:B16); a deeper level is
 * refused.
 */
const nestingOf = Effect.fnUntraced(function* nestingOf(
	ctx: Context,
	input: RuleInput,
	node: EncodingNode,
	buildAll: BuildAll
): Effect.fn.Return<Nesting> {
	const nests =
		Record.keys(node.encoding ?? {}).length > 0 || (node.prefixEncoding ?? []).length > 0
	if (input.depth === 1 && (nests || node.itemEncoding !== undefined)) {
		return refuseNesting(
			nestingRefusal(
				"ENC-16/nesting-too-deep",
				"Encoding nested more than one level",
				"Nested encoding is supported for one level only.",
				input.actual
			)
		)
	}

	const item = node.itemEncoding
	const children =
		(!nests && item === undefined) || input.schema === undefined
			? noMembers
			: yield* membersOf(ctx.walk, input.schema)
	const entries = nestedEntries(node, input.actual, children)
	if (Result.isFailure(entries)) {
		return refuseNesting(entries.failure)
	}

	const inputs = Arr.map(entries.success, (entry): RuleInput => ({
		actual: entry.actual,
		depth: 1,
		formData: false,
		honorsStyle: false,
		node: entry.node,
		schema: memberSchema(children, entry.target),
		target: entry.target
	}))
	const itemInput: readonly RuleInput[] =
		item === undefined
			? []
			: [
					{
						actual: childKey(input.actual, "itemEncoding"),
						depth: 1,
						formData: false,
						honorsStyle: false,
						node: item,
						schema: children.items,
						target: { index: (node.prefixEncoding ?? []).length, kind: "position" }
					}
				]
	const built = yield* buildAll(ctx, [...inputs, ...itemInput])
	const rules = Arr.map(built.rules, (rule) => toNested(rule))

	return {
		findings: built.findings,
		item: item === undefined ? undefined : rules[inputs.length],
		nested: rules.slice(0, inputs.length),
		refused: built.refused,
		rows: nestedRows(node)
	}
})

interface TransferResult {
	readonly encoding: "base64" | undefined
	readonly finding: Finding | undefined
	readonly row: RowId | undefined
}

const noTransfer: TransferResult = { encoding: undefined, finding: undefined, row: undefined }

const base64Transfer = (row: RowId): TransferResult => ({
	encoding: "base64",
	finding: undefined,
	row
})

const transferAnchor = (line: SpecLine): string =>
	line === "3.2"
		? "content-transfer-encoding-and-contentencoding"
		: "encoding-multipart-media-types"

/**
 * Transfer encodings are case-insensitive tokens (RFC 2045 6.1).
 */
const isBase64 = (value: string): boolean => Str.toLowerCase(value) === "base64"

/**
 * The identity encodings of RFC 2045 6.2: the part is not transformed.
 */
const identityEncodings: ReadonlySet<string> = new Set(["7bit", "8bit", "binary"])

const isIdentity = (value: string): boolean => identityEncodings.has(Str.toLowerCase(value))

/**
 * What one schema declares: 3.0 `format: byte` (ENC-38), 3.1+ `contentEncoding` (ENC-37). base64
 * has a writer; an identity encoding sends the part raw, as a 3.0 `format: binary` part is, with no
 * Content-Transfer-Encoding line of its own. Any other `contentEncoding` refuses the part.
 */
const declaredTransfer = (
	line: SpecLine,
	label: string,
	facts: Facts
): TransferResult | undefined => {
	if (line === "3.0") {
		return facts.format === "byte" ? base64Transfer("ENC-38") : undefined
	}

	const declared = facts.contentEncoding
	if (declared === undefined) {
		return undefined
	}

	if (isBase64(declared.value)) {
		return base64Transfer("ENC-37")
	}

	return isIdentity(declared.value)
		? { ...noTransfer, row: "ENC-37" }
		: {
				...noTransfer,
				finding: dropping(
					refusal(
						"ENC-37/unsupported-content-encoding",
						transferAnchor(line),
						"Multipart part contentEncoding",
						`The contentEncoding ${quoted(declared.value)} of ${quoted(label)} is neither base64 nor an identity encoding (binary, 7bit, 8bit), the transfer encodings a part is sent with.`,
						childKey(declared.at, "contentEncoding"),
						"Use contentEncoding base64 or binary, or remove it to send the part as is"
					)
				)
			}
}

/**
 * A part's transfer encoding, from its schema or, for a repeated part, its items. A nested part
 * has no field to hold one, so it is refused rather than sent unencoded.
 */
const transferOf = (ctx: Context, input: RuleInput, facts: Facts): TransferResult => {
	const label = targetLabel(input.target)
	const found =
		declaredTransfer(ctx.line, label, facts) ??
		pipe(
			facts.items,
			UndefinedOr.map((items) => declaredTransfer(ctx.line, label, items))
		) ??
		noTransfer
	if (input.depth === 0 || found.encoding === undefined) {
		return found
	}

	return {
		...noTransfer,
		finding: dropping(
			plainRefusal(
				`${found.row}/nested-transfer-encoding`,
				transferAnchor(ctx.line),
				"Transfer encoding of a nested part",
				`The nested part ${quoted(label)} declares a base64 transfer encoding, which a nested part cannot carry.`,
				input.actual
			)
		)
	}
}

/**
 * What ENC-39 reads of a Content-Transfer-Encoding header's schema: its `const` and its `enum`.
 */
interface TransferSchemaNode {
	readonly const: unknown
	readonly enum: ReadonlyArray<unknown> | undefined
}

const transferSchema: Read.Reader<TransferSchemaNode> = (value) =>
	Result.flatMap(Read.members(value), (object) =>
		Read.struct(
			object,
			{
				const: optional(object, "const", Read.anything),
				enum: optional(object, "enum", Read.array(Read.anything))
			},
			Read.anything
		)
	)

/**
 * The schema of a header whose schema is no readable object: it rules nothing out.
 */
const noTransferSchema: TransferSchemaNode = { const: undefined, enum: undefined }

const transferHeaderOf = (node: EncodingNode): string | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(
			Record.keys(node.headers ?? {}),
			(name) => Str.toLowerCase(name) === "content-transfer-encoding"
		)
	)

/**
 * A header schema keyword admits base64 when it is absent or lists it among its string values.
 */
const admitsBase64 = (values: readonly string[] | undefined): boolean =>
	values === undefined || Arr.some(values, isBase64)

/**
 * ENC-39: a declared Content-Transfer-Encoding header whose schema rules out the part's base64.
 */
const transferConflict = Effect.fnUntraced(function* transferConflict(
	ctx: Context,
	input: RuleInput,
	name: string
): Effect.fn.Return<Finding | undefined> {
	const header = follow(ctx.resolution, childKey(input.actual, "headers", name))
	const at = follow(ctx.resolution, childKey(header, "schema"))
	const schema = yield* nodeIn(ctx.resolution, at).pipe(
		Effect.map((json) => Result.getOrElse(transferSchema(json), () => noTransferSchema)),
		Effect.orElseSucceed(() => noTransferSchema)
	)
	const declared = {
		const: pipe(
			schema.const,
			UndefinedOr.map((value) => Arr.filter([value], Predicate.isString))
		),
		enum: pipe(
			schema.enum,
			UndefinedOr.map((values) => Arr.filter(values, Predicate.isString))
		)
	}
	const keyword = Option.getOrUndefined(
		Arr.findFirst(["const", "enum"] as const, (field) => !admitsBase64(declared[field]))
	)

	return pipe(
		keyword,
		UndefinedOr.map((field) =>
			dropping(
				refusal(
					"ENC-39/conflicting-transfer-encoding",
					transferAnchor(ctx.line),
					"Encoding header Content-Transfer-Encoding",
					`The Content-Transfer-Encoding schema of ${quoted(targetLabel(input.target))} does not admit base64, the transfer encoding its schema declares.`,
					childKey(at, field),
					"Remove the header, or let its schema admit base64"
				)
			)
		)
	)
})

/**
 * A nesting part's rules on its rule: `nested` is present whenever the part nests, so an item rule
 * alone still marks it, and `nestedItem` holds the nested `itemEncoding`'s rule (ENC-09).
 */
const withNesting = (rule: PlainRule, nesting: Nesting): void => {
	if (nesting.nested.length > 0 || nesting.item !== undefined) {
		rule.nested = nesting.nested
	}

	if (nesting.item !== undefined) {
		rule.nestedItem = nesting.item
	}
}

/**
 * One Encoding Object, or the table default of a part that has none, as a rule (design 2.2).
 */
const buildRule = Effect.fnUntraced(function* buildRule(
	ctx: Context,
	input: RuleInput,
	buildAll: BuildAll
): Effect.fn.Return<RuleResult> {
	const node = input.node ?? noEncoding
	const facts = yield* factsOf(ctx.walk, input.schema, 0)
	const typing = yield* partTypingOf(ctx, input, node, facts)
	if (typing.refused) {
		return { findings: typing.findings, rule: undefined }
	}

	const transfer = transferOf(ctx, input, facts)
	if (transfer.finding !== undefined) {
		return { findings: [...typing.findings, transfer.finding], rule: undefined }
	}

	const headers = yield* headersOf(ctx, input, node)
	const transferHeader = transferHeaderOf(node)
	const conflict =
		transfer.encoding === undefined || headers.headers === undefined || transferHeader === undefined
			? undefined
			: yield* transferConflict(ctx, input, transferHeader)
	if (conflict !== undefined) {
		const kept = Arr.filter(headers.findings, ({ code }) => code !== writerOwnedCode)

		return { findings: [...typing.findings, ...kept, conflict], rule: undefined }
	}

	const nesting = yield* nestingOf(ctx, input, node, buildAll)
	/**
	 * ENC-40: a style the writer sends is name and raw value under `text/plain`; any other style
	 * refuses the part alone, and the rule keeps its style so the names plan gives it no flag.
	 */
	const styled = typing.serialization
	const pairs = styled !== undefined && sendsFormPairs(styled)
	const findings = [
		...typing.findings,
		...headers.findings,
		...nesting.findings,
		...(styled === undefined || pairs ? [] : [unsupportedPartStyle(input)])
	]
	if (headers.headers === undefined || nesting.refused) {
		return { findings, rule: undefined }
	}

	const rule: PlainRule = {
		contentType: pairs ? [textPlain] : typing.contentType,
		headers: headers.headers,
		origin: yield* originOf(input.actual),
		rows: sorted([
			...typing.rows,
			...nesting.rows,
			...(headers.declares ? (["ENC-03"] as const) : []),
			...(transfer.row === undefined ? [] : [transfer.row]),
			...(styled === undefined ? [] : (["ENC-40"] as const))
		]),
		target: input.target
	}
	if (transfer.encoding !== undefined) {
		rule.contentEncoding = transfer.encoding
	}

	withNesting(rule, nesting)
	if (typing.serialization !== undefined) {
		rule.serialization = typing.serialization
	}

	return { findings, rule }
})

/**
 * Builds the rules in order and stops at the first refusal.
 */
const buildAll: BuildAll = Effect.fnUntraced(function* all(
	ctx: Context,
	inputs: readonly RuleInput[]
): Effect.fn.Return<Batch> {
	const findings: Finding[] = []
	const rules: PlainRule[] = []
	for (const input of inputs) {
		const result = yield* buildRule(ctx, input, buildAll)
		for (const finding of result.findings) {
			findings.push(finding)
		}

		if (result.rule === undefined) {
			return { findings, refused: true, rules: [] }
		}

		rules.push(result.rule)
	}

	return { findings, refused: false, rules }
})

interface PlainAlternative {
	readonly codec: Codec
	readonly encoding: readonly PlainRule[]
	itemEncoding?: PlainRule
	itemSchema?: { readonly key: string }
	readonly mediaType: MediaRange
	readonly origin: Origin
	readonly prefixEncoding: readonly PlainRule[]
	refusedFields?: ReadonlyArray<WireName>
	readonly rows: ReadonlyArray<RowId>
	schema?: { readonly key: string }
}

interface AlternativeResult {
	readonly alternative: PlainAlternative | undefined
	readonly findings: readonly Finding[]
}

const stopAlternative = (findings: readonly Finding[]): AlternativeResult => ({
	alternative: undefined,
	findings
})

/**
 * Every line reports `SCH-13`, 3.0 included: reporting `S30-24` for 3.0 would change its diagnostics.
 */
const extraFieldsRefusal = (at: CanonicalKey): Finding =>
	refusal(
		"SCH-13/multipart-extra-fields",
		"json-schema-keywords",
		"Multipart schema additionalProperties",
		"A schema-valued additionalProperties on a multipart body root would add parts the declared properties do not name.",
		at,
		"D-ENC1 decides extra multipart fields; until then this map is refused and the declared parts stay"
	)

const encodingIgnored = (line: SpecLine, at: CanonicalKey): Finding =>
	line === "3.2"
		? notice(
				"MED-14/encoding-ignored",
				"encoding-usage-and-restrictions",
				"Media type encoding fields",
				"Encoding fields SHALL be ignored for media types other than multipart and form-urlencoded.",
				at
			)
		: notice(
				"MED-10/encoding-ignored",
				"media-type-encoding",
				"Media type encoding",
				"The encoding field applies to multipart and form-urlencoded request bodies only, so it is ignored here.",
				at
			)

/**
 * D-OC5: a Media Type description has no use in a generated CLI, so it is ignored.
 */
const descriptionIgnored = (at: CanonicalKey): Finding =>
	notice(
		"MED-09/description-ignored",
		"media-type-object",
		"Media type description",
		"The description of a media type is not used, so it is ignored here.",
		at
	)

/**
 * MED-26: a form-data body is a set of named parts, so an array of name/value objects has no part
 * flags to fill and every run would fail.
 */
const arrayFormData = (at: CanonicalKey): Finding =>
	refusal(
		"MED-26/array-form-data",
		"encoding-multipart-media-types",
		"Multipart form-data array body",
		"A multipart/form-data body whose schema is an array has no named parts to send, so the media type is refused.",
		at,
		"Describe the body as an object whose properties are the parts"
	)

/**
 * MED-25: a multipart type other than form-data sends unnamed ordered parts, and correlating them
 * with an object's properties by a Content-Disposition name is a MAY this generator does not offer.
 */
const unnamedParts = (line: SpecLine, at: CanonicalKey): Finding =>
	refusal(
		"MED-25/unnamed-parts",
		line === "3.2" ? "additional-encoding-approaches" : "encoding-multipart-media-types",
		"Multipart object body other than form-data",
		"This multipart type sends unnamed parts in order, which the object schema's named properties do not map to, so the media type is refused.",
		at,
		line === "3.2"
			? "Use multipart/form-data, or describe the parts in order with an array schema"
			: "Use multipart/form-data"
	)

interface Media {
	readonly home: CanonicalKey
	readonly node: MediaNode
}

const readMedia = (
	resolution: Resolution,
	mediaSite: CanonicalKey
): Effect.Effect<Media, BodyNotReadable> => {
	const home = follow(resolution, mediaSite)

	return nodeIn(resolution, home).pipe(
		Effect.flatMap((json) => Effect.fromResult(mediaTypeObject(json))),
		Effect.mapBoth({
			onFailure: () =>
				new BodyNotReadable({ pointer: mediaSite.pointer, reason: "media-type-not-an-object" }),
			onSuccess: (node) => ({ home, node })
		})
	)
}

const alternativeRows = (
	line: SpecLine,
	codec: Codec,
	node: MediaNode,
	schema: boolean,
	itemSchema: boolean
): ReadonlyArray<RowId> =>
	sorted([
		"MED-01",
		...(schema ? (["MED-02"] as const) : []),
		...(itemSchema ? (["MED-03"] as const) : []),
		...(node.encoding === undefined ? [] : (["MED-06"] as const)),
		...(node.prefixEncoding === undefined ? [] : (["MED-07"] as const)),
		...(node.itemEncoding === undefined ? [] : (["MED-08"] as const)),
		...(schema || itemSchema ? [] : ([line === "3.0" ? "RQB-10" : "RQB-09"] as const)),
		...(codec === "form" ? ([line === "3.2" ? "ENC-28" : "ENC-27", "ENC-29"] as const) : [])
	])

interface Parts {
	readonly encoding: readonly PlainRule[]
	readonly findings: readonly Finding[]
	readonly itemEncoding: PlainRule | undefined
	readonly prefixEncoding: readonly PlainRule[]
	readonly refused: boolean
	/**
	 * The properties refused at `field` scope, in property order (design 8.5).
	 */
	readonly refusedFields: ReadonlyArray<WireName>
}

const noParts: Parts = {
	encoding: [],
	findings: [],
	itemEncoding: undefined,
	prefixEncoding: [],
	refused: false,
	refusedFields: []
}

const refusedParts = (findings: readonly Finding[]): Parts => ({
	...noParts,
	findings,
	refused: true
})

/**
 * The schema-valued additionalProperties of a multipart root, found through `$ref` and `allOf`.
 */
const extraFields = (ctx: Context, schema: CanonicalKey): Effect.Effect<readonly Finding[]> =>
	flatten(ctx.walk, schema).pipe(
		Effect.map((nodes) => {
			const found = firstLocated(nodes, (node) =>
				Predicate.isObject(node.additionalProperties) ? true : undefined
			)

			return found === undefined
				? []
				: [extraFieldsRefusal(childKey(found.at, "additionalProperties"))]
		})
	)

/**
 * ENC-33 and MED-13: a multipart body this line cannot read at all.
 */
const partsBlocker = (line: SpecLine, media: Media): Finding | undefined => {
	const { home, node } = media
	const positional = node.prefixEncoding !== undefined || node.itemEncoding !== undefined
	if (node.schema === undefined && line !== "3.2") {
		return plainRefusal(
			"ENC-33/missing-schema",
			"encoding-multipart-media-types",
			"Multipart media type without a schema",
			"A multipart body REQUIRES a schema in this OpenAPI line.",
			home
		)
	}

	return line === "3.2" && node.encoding !== undefined && positional
		? plainRefusal(
				"MED-13/encoding-with-positional",
				"media-type-encoding",
				"Media type encoding with prefixEncoding or itemEncoding",
				"encoding MUST NOT appear with prefixEncoding or itemEncoding.",
				home
			)
		: undefined
}

interface Keys {
	readonly findings: readonly Finding[]
	readonly refused: boolean
}

/**
 * MED-11 refuses an encoding key that names no property; MED-12 (3.2) ignores it with a notice.
 */
const unknownKeys = (line: SpecLine, media: Media, members: Members): Keys => {
	const declared = new Set(Arr.map(members.properties, ([name]) => name))
	const findings: Finding[] = []
	for (const name of Record.keys(media.node.encoding ?? {})) {
		const actual = childKey(media.home, "encoding", name)
		if (!declared.has(name) && line !== "3.2") {
			return {
				findings: [
					dropping(
						plainRefusal(
							"MED-11/unknown-property",
							"media-type-encoding",
							"Media type encoding key",
							`The encoding key ${quoted(name)} is not a property of the schema.`,
							actual
						)
					)
				],
				refused: true
			}
		}

		if (!declared.has(name)) {
			findings.push(
				notice(
					"MED-12/absent-property-ignored",
					"encoding-by-name",
					"Media type encoding key",
					`The encoding key ${quoted(name)} names no schema property, so it is ignored.`,
					actual
				)
			)
		}
	}

	return { findings, refused: false }
}

/**
 * One input per declared property in document order, with its Encoding Object when it has one.
 */
const propertyInputs = (
	media: Media,
	members: Members,
	honorsStyle: boolean,
	formData: boolean
): Result.Result<ReadonlyArray<RuleInput>, Finding> => {
	const byName = media.node.encoding ?? {}

	return Result.all(
		Arr.map(members.properties, ([name, schema]) => {
			const explicit = Option.getOrUndefined(Record.get(byName, name))
			const actual = explicit === undefined ? schema : childKey(media.home, "encoding", name)

			return Result.map(namedTarget(name, actual), (target): RuleInput => ({
				actual,
				depth: 0,
				formData,
				honorsStyle,
				node: explicit,
				schema,
				target
			}))
		})
	)
}

interface PartInputs {
	readonly inputs: readonly RuleInput[]
	/**
	 * How many of `inputs`, after the properties, are `prefixEncoding` positions; an item rule
	 * follows.
	 */
	readonly prefixCount: number
}

/**
 * One input per declared property, then per position, then the item rule. A 3.2 positional
 * `multipart/mixed` body (HT:B15) gives every `prefixItems` position a rule, its Encoding Object or
 * else the default table, and `items` or `itemSchema` an item rule; elsewhere only the declared
 * `prefixEncoding` entries and `itemEncoding` become rules.
 */
const partInputs = (
	line: SpecLine,
	media: Media,
	members: Members,
	options: { readonly formData: boolean; readonly honorsStyle: boolean; readonly mixed: boolean }
): Result.Result<PartInputs, Finding> => {
	const { home, node } = media
	const { formData, honorsStyle, mixed } = options
	const prefix = line === "3.2" ? (node.prefixEncoding ?? []) : []
	const item = line === "3.2" ? node.itemEncoding : undefined
	const positional = line === "3.2" && mixed
	const count = positional ? Math.max(prefix.length, members.prefixItems.length) : prefix.length
	const named = propertyInputs(media, members, honorsStyle, formData)
	const positions = Array.from({ length: count }, (_, index): RuleInput => {
		const entry = prefix[index]
		const schema = members.prefixItems[index]

		return {
			actual:
				entry === undefined && schema !== undefined
					? schema
					: childKey(home, "prefixEncoding", String(index)),
			depth: 0,
			formData,
			honorsStyle,
			node: entry,
			schema,
			target: { index, kind: "position" }
		}
	})
	const itemSchema = node.itemSchema === undefined ? members.items : childKey(home, "itemSchema")
	const defaulted = positional && itemSchema !== undefined
	const remaining: RuleInput[] =
		item === undefined && !defaulted
			? []
			: [
					{
						actual:
							item === undefined && itemSchema !== undefined
								? itemSchema
								: childKey(home, "itemEncoding"),
						depth: 0,
						formData,
						honorsStyle,
						node: item,
						schema: itemSchema,
						target: { index: count, kind: "position" }
					}
				]

	return Result.map(named, (properties) => ({
		inputs: [...properties, ...positions, ...remaining],
		prefixCount: count
	}))
}

/**
 * Multipart part rules: the declared properties by name, then 3.2 positions (design 6.3).
 */
const typesOf = (nodes: readonly Located[]): readonly string[] => {
	const type = firstLocated(nodes, (node) => node.type)?.value

	return typeNames(type)
}

/**
 * An array root: typed array, or item schemas with no declared properties.
 */
const isArrayBody = Effect.fnUntraced(function* isArrayBody(
	walk: Walk,
	schema: CanonicalKey,
	members: Members
): Effect.fn.Return<boolean> {
	if (
		members.properties.length === 0 &&
		(members.items !== undefined || members.prefixItems.length > 0)
	) {
		return true
	}

	const nodes = yield* flatten(walk, schema)

	return Arr.contains(typesOf(nodes), "array")
})

/**
 * An object root: not an array body, and typed object or with declared properties.
 */
const isObjectBody = Effect.fnUntraced(function* isObjectBody(
	walk: Walk,
	schema: CanonicalKey,
	members: Members
): Effect.fn.Return<boolean> {
	if (yield* isArrayBody(walk, schema, members)) {
		return false
	}

	if (members.properties.length > 0) {
		return true
	}

	const nodes = yield* flatten(walk, schema)

	return Arr.contains(typesOf(nodes), "object")
})

interface PartStyles {
	readonly drops: boolean
	readonly findings: readonly Finding[]
	readonly refusedFields: ReadonlyArray<WireName>
}

/**
 * ENC-40 on a named part follows the form property rules (design 8.5 rules 2, 3 and 11): refused
 * at `field` scope when every named part it refuses is optional, otherwise every one of them drops
 * the alternative. A 3.2 positional entry has no name, so its refusal keeps `element` scope.
 */
const partStyles = Effect.fnUntraced(function* partStyles(
	ctx: Context,
	schema: CanonicalKey | undefined,
	inputs: readonly RuleInput[],
	findings: readonly Finding[]
): Effect.fn.Return<PartStyles> {
	const named = new Map(
		Arr.flatMap(inputs, (input): ReadonlyArray<readonly [string, WireName]> =>
			input.target.kind === "property" ? [[keyOf(input.actual), input.target.name]] : []
		)
	)
	const nameOf = (finding: Finding): Option.Option<WireName> =>
		finding.code === unsupportedPartStyleCode
			? Option.fromUndefinedOr(named.get(keyOf(finding.at)))
			: Option.none()
	const refusedFields = Arr.getSomes(Arr.map(findings, nameOf))
	if (schema === undefined || refusedFields.length === 0) {
		return { drops: false, findings, refusedFields: [] }
	}

	const requirement = yield* requirementOf(ctx.walk, schema)
	const drops = Arr.some(refusedFields, (name) => isRequired(requirement, name))
	const moved = (finding: Finding, name: string): Finding =>
		drops ? dropping(finding) : fieldRefusal(finding.at, finding, name)

	return {
		drops,
		findings: Arr.map(findings, (finding) =>
			Option.match(nameOf(finding), {
				onNone: () => finding,
				onSome: (name) => moved(finding, name)
			})
		),
		refusedFields: drops ? [] : refusedFields
	}
})

const multipartParts = Effect.fnUntraced(function* multipartParts(
	ctx: Context,
	media: Media,
	base: string
): Effect.fn.Return<Parts> {
	const { line } = ctx
	const blocker = partsBlocker(line, media)
	if (blocker !== undefined) {
		return refusedParts([blocker])
	}

	const schema = media.node.schema === undefined ? undefined : childKey(media.home, "schema")
	const members = schema === undefined ? noMembers : yield* membersOf(ctx.walk, schema)
	if (
		schema !== undefined &&
		base === "multipart/form-data" &&
		(yield* isArrayBody(ctx.walk, schema, members))
	) {
		return refusedParts([arrayFormData(media.home)])
	}

	if (
		schema !== undefined &&
		base !== "multipart/form-data" &&
		!Str.endsWith("/*")(base) &&
		(yield* isObjectBody(ctx.walk, schema, members))
	) {
		return refusedParts([dropping(unnamedParts(line, schema))])
	}

	const extra = schema === undefined ? [] : yield* extraFields(ctx, schema)
	const keys = unknownKeys(line, media, members)
	if (keys.refused) {
		return refusedParts([...extra, ...keys.findings])
	}

	const named = partInputs(line, media, members, {
		formData: base === "multipart/form-data",
		honorsStyle: base === "multipart/form-data" && line !== "3.0",
		mixed: base === "multipart/mixed"
	})
	if (Result.isFailure(named)) {
		return refusedParts([...extra, ...keys.findings, named.failure])
	}

	const { inputs, prefixCount } = named.success
	const built = yield* buildAll(ctx, inputs)
	if (built.refused) {
		return refusedParts([...extra, ...keys.findings, ...built.findings])
	}

	const styled = yield* partStyles(ctx, schema, inputs, built.findings)
	const findings = [...extra, ...keys.findings, ...styled.findings]
	if (styled.drops) {
		return refusedParts(findings)
	}

	const propertyCount = members.properties.length
	const positioned = built.rules.slice(propertyCount)

	return {
		encoding: built.rules.slice(0, propertyCount),
		findings,
		itemEncoding: positioned[prefixCount],
		prefixEncoding: positioned.slice(0, prefixCount),
		refused: false,
		refusedFields: styled.refusedFields
	}
})

const multipartOnly = (code: string, anchor: string, field: string, at: CanonicalKey): Finding =>
	notice(
		code,
		anchor,
		`Encoding ${field} under form-urlencoded`,
		`The ${field} field applies to multipart media types only, so it is ignored for form-urlencoded.`,
		at
	)

/**
 * Fields a form value has no use for, in pointer order: part headers (ENC-11) and nested encoding
 * (ENC-07 to ENC-09).
 */
const formIgnored = (node: EncodingNode, actual: CanonicalKey): readonly Finding[] => [
	...(node.encoding === undefined
		? []
		: [
				multipartOnly(
					"ENC-07/nested-encoding-ignored",
					"encoding-encoding",
					"encoding",
					childKey(actual, "encoding")
				)
			]),
	...(node.headers === undefined
		? []
		: [
				multipartOnly(
					"ENC-11/headers-ignored",
					"encoding-headers",
					"headers",
					childKey(actual, "headers")
				)
			]),
	...(node.itemEncoding === undefined
		? []
		: [
				multipartOnly(
					"ENC-09/item-encoding-ignored",
					"encoding-item-encoding",
					"itemEncoding",
					childKey(actual, "itemEncoding")
				)
			]),
	...(node.prefixEncoding === undefined
		? []
		: [
				multipartOnly(
					"ENC-08/prefix-encoding-ignored",
					"encoding-prefix-encoding",
					"prefixEncoding",
					childKey(actual, "prefixEncoding")
				)
			])
]

const formContentTypeRefusal = (input: RuleInput, expected: string): Finding =>
	dropping(
		refusal(
			"ENC-02/form-content-type",
			"encoding-content-type",
			"Encoding contentType under form-urlencoded",
			`The contentType of ${quoted(targetLabel(input.target))} differs from ${expected}, the type a form value is sent as.`,
			childKey(input.actual, "contentType"),
			`Remove contentType, or set it to ${expected}`
		)
	)

/**
 * PRM-27 (design 6.1): a deepObject value is nested when its schema is an array, or declares a
 * property or additionalProperties schema whose type is or includes object or array. An untyped
 * member is not nested.
 */
const isNested = Effect.fnUntraced(function* isNested(
	walk: Walk,
	schema: CanonicalKey | undefined
): Effect.fn.Return<boolean> {
	if (schema === undefined) {
		return false
	}

	const nodes = yield* flatten(walk, schema)
	if (typesOf(nodes).includes("array")) {
		return true
	}

	const members = Arr.flatMap(nodes, ({ at, node }) => [
		...Arr.map(Record.keys(node.properties ?? {}), (name) => childKey(at, "properties", name)),
		...(Predicate.isObject(node.additionalProperties) ? [childKey(at, "additionalProperties")] : [])
	])
	for (const member of members) {
		const reached = yield* flatten(walk, member)
		if (compound(typesOf(reached))) {
			return true
		}
	}

	return false
})

const compoundNested = (input: RuleInput): Finding =>
	dropping(
		refusal(
			"PRM-27/compound-nested",
			"style-values",
			"Encoding style deepObject under form-urlencoded",
			`The deepObject value of ${quoted(targetLabel(input.target))} has nested objects or arrays, which the specification does not define.`,
			input.actual,
			"Set nonStandard.deepObjectBrackets in the author config to send it in the bracket convention"
		)
	)

const bracketChoice = (input: RuleInput): Finding =>
	notice(
		bracketChoiceCode,
		"style-values",
		"Encoding style deepObject under form-urlencoded",
		`The author config sends the nested deepObject value of ${quoted(targetLabel(input.target))} in the bracket convention, which the specification does not define.`,
		input.actual
	)

const scalarChoice = (input: RuleInput): Finding =>
	notice(
		scalarChoiceCode,
		"style-values",
		"Encoding style deepObject under form-urlencoded",
		`The author config sends a scalar deepObject value of ${quoted(targetLabel(input.target))} as name=value, which the specification does not define.`,
		input.actual
	)

/**
 * The scalar switch's decision for a form deepObject entry, by the query parameter rule (design
 * 6.1 Scalar switch); `Strict` for any other style.
 */
const scalarCoverOf = (
	ctx: Context,
	input: RuleInput,
	serialization: PlainSerialization | undefined
): ScalarCover =>
	serialization?.style !== "deepObject" || input.schema === undefined
		? "strict"
		: scalarCover(ctx.resolution, input.schema, ctx.site.nonStandard)

/**
 * The query style table's refusal for a form property's explicit style fields (design 6.3, through
 * the parameter rule `formStyleRefusal`), placed at the Encoding entry; it drops the alternative.
 */
const styleRefusalOf = (
	ctx: Context,
	input: RuleInput,
	serialization: PlainSerialization | undefined
): Option.Option<Finding> =>
	serialization === undefined
		? Option.none()
		: Option.map(formStyleRefusal(ctx.resolution, input.schema, serialization), (found) =>
				dropping({
					anchor: found.anchor,
					at: input.actual,
					code: found.code,
					element: "Encoding style under form-urlencoded",
					...(found.hint === undefined ? {} : { hint: found.hint }),
					message: found.message,
					severity: "refusal"
				})
			)

/**
 * ENC-12 (design D-OC14): a 3.0 or 3.1 form deepObject with explode false or omitted is exploded,
 * as STY-26 is for a parameter, with that row's notice text.
 */
const deepObjectExplode = (
	line: SpecLine,
	serialization: PlainSerialization | undefined,
	actual: CanonicalKey
): readonly Finding[] =>
	line !== "3.2" && serialization?.style === "deepObject" && serialization.explode !== true
		? [
				notice(
					"ENC-12/explode-no-effect",
					"encoding-explode",
					"Encoding deepObject explode",
					deepObjectExplodeText,
					actual
				)
			]
		: []

/**
 * What PRM-27 does to one form rule: nothing, refuse its alternative (strict), or mark it for the
 * bracket convention (the author config's switch, never defaulted or inferred).
 */
type DeepObjectAction = "mark" | "none" | "refuse"

const deepObjectOf = Effect.fnUntraced(function* deepObjectOf(
	ctx: Context,
	input: RuleInput,
	serialization: PlainSerialization | undefined
): Effect.fn.Return<DeepObjectAction> {
	if (serialization?.style !== "deepObject" || !(yield* isNested(ctx.walk, input.schema))) {
		return "none"
	}

	return ctx.site.nonStandard?.deepObjectBrackets === true ? "mark" : "refuse"
})

/**
 * What PRM-27 does to one form rule once the scalar switch has decided: its covered branches
 * (refused when a nested branch or member union is uncovered, marked when the bracket switch covers
 * a nested one), or the strict nested test.
 */
const coveredDeepObject = (
	ctx: Context,
	input: RuleInput,
	serialization: PlainSerialization | undefined,
	cover: ScalarCover
): Effect.Effect<DeepObjectAction> => {
	switch (cover) {
		case "scalars": {
			return Effect.succeed("none")
		}
		case "scalarsAndNested": {
			return Effect.succeed("mark")
		}
		case "strict": {
			return deepObjectOf(ctx, input, serialization)
		}
		case "uncovered": {
			return Effect.succeed("refuse")
		}
	}
}

/**
 * One form property's rule. Style fields apply on every line (ENC-12; 3.0 per ENC-14); without
 * them the value is sent by the default table, so an explicit contentType is kept only when it
 * names the table's type, which changes nothing on the wire. Style fields the query style table
 * marks not applicable refuse the alternative (STY-17 to STY-24, PRM-27), and a deepObject over a
 * nested value refuses it unless the author config opts into brackets (PRM-27).
 */
const formRule = Effect.fnUntraced(function* formRule(
	ctx: Context,
	input: RuleInput
): Effect.fn.Return<RuleResult> {
	const node = input.node ?? noEncoding
	const typing = yield* typingOf(ctx, input, node, factsOf(ctx.walk, input.schema, 0))
	if (typing.refused) {
		return { findings: typing.findings, rule: undefined }
	}

	/**
	 * Under the scalar switch the branch walk decides a deepObject entry the strict object test
	 * would refuse; the style table refuses nothing else for deepObject (design 6.1 Scalar switch).
	 */
	const cover = scalarCoverOf(ctx, input, typing.serialization)
	const inapplicable =
		cover === "strict" ? styleRefusalOf(ctx, input, typing.serialization) : Option.none()
	if (Option.isSome(inapplicable)) {
		return { findings: [...typing.findings, inapplicable.value], rule: undefined }
	}

	const deepObject = yield* coveredDeepObject(ctx, input, typing.serialization, cover)
	if (deepObject === "refuse") {
		return { findings: [...typing.findings, compoundNested(input)], rule: undefined }
	}

	const explicit = typing.serialization === undefined && node.contentType !== undefined
	const facts = explicit ? yield* factsOf(ctx.walk, input.schema, 0) : noFacts
	const fallback = explicit ? defaultFor(ctx.line, facts, input) : undefined
	const [given] = typing.contentType
	if (
		fallback !== undefined &&
		(typing.contentType.length !== 1 ||
			pipe(given, UndefinedOr.map(Str.toLowerCase)) !== fallback.type)
	) {
		return {
			findings: [...typing.findings, formContentTypeRefusal(input, fallback.type)],
			rule: undefined
		}
	}

	const rule: PlainRule = {
		contentType: typing.contentType,
		headers: [],
		origin: yield* originOf(input.actual),
		rows: sorted([
			...typing.rows,
			...(fallback === undefined ? [] : [fallback.row]),
			...(typing.serialization === undefined ? [] : (["ENC-12"] as const)),
			...(ctx.line === "3.0" ? (["ENC-14"] as const) : [])
		]),
		target: input.target
	}
	if (typing.serialization !== undefined) {
		rule.serialization = typing.serialization
	}

	if (deepObject === "mark") {
		rule.nonStandard = "deepObjectBrackets"
	}

	const covered = cover === "scalars" || cover === "scalarsAndNested"
	if (covered) {
		rule.nonStandardScalars = "deepObjectScalars"
	}

	return {
		findings: [
			...typing.findings,
			...(deepObject === "mark" ? [bracketChoice(input)] : []),
			...(covered ? [scalarChoice(input)] : []),
			...deepObjectExplode(ctx.line, typing.serialization, input.actual),
			...formIgnored(node, input.actual)
		],
		rule
	}
})

/**
 * Positional encoding applies to multipart only (MED-07, MED-08), so a form alternative ignores it.
 */
const formPositional = (media: Media): readonly Finding[] => [
	...(media.node.itemEncoding === undefined
		? []
		: [
				multipartOnly(
					"MED-08/item-encoding-ignored",
					"media-type-item-encoding",
					"itemEncoding",
					childKey(media.home, "itemEncoding")
				)
			]),
	...(media.node.prefixEncoding === undefined
		? []
		: [
				multipartOnly(
					"MED-07/prefix-encoding-ignored",
					"media-type-prefix-encoding",
					"prefixEncoding",
					childKey(media.home, "prefixEncoding")
				)
			])
]

/**
 * A refused form alternative sends nothing, so no entry of it is sent in the bracket convention or
 * as a scalar pair: its author-choice notices go with it (design 8.4, 8.5 rule 7), whatever the
 * order of its properties.
 */
const refusedFormParts = (findings: readonly Finding[]): Parts =>
	refusedParts(Arr.filter(findings, (finding) => !authorChoiceCodes.has(finding.code)))

/**
 * Form-urlencoded rules: one per declared property, by name (MED-11, MED-12 as for multipart).
 * With `fields` (a request body, design 8.5 rules 2, 3 and 11), a property whose rule refuses is
 * refused at `field` scope when it is optional, and the alternative stays; a required one drops
 * the alternative with every entry's dropping refusals, so no `field` record outlives it. Without
 * (a `querystring` content entry, design 6.1), the first refusing rule refuses the entry.
 */
const formParts = Effect.fnUntraced(function* formParts(
	ctx: Context,
	media: Media,
	fields: boolean
): Effect.fn.Return<Parts> {
	const schema = media.node.schema === undefined ? undefined : childKey(media.home, "schema")
	const members = schema === undefined ? noMembers : yield* membersOf(ctx.walk, schema)
	const keys = unknownKeys(ctx.line, media, members)
	if (keys.refused) {
		return refusedParts(keys.findings)
	}

	const findings: Finding[] = [...keys.findings, ...formPositional(media)]
	const inputs = propertyInputs(media, members, true, false)
	if (Result.isFailure(inputs)) {
		return refusedFormParts([...findings, inputs.failure])
	}

	const rules: PlainRule[] = []
	const refusedFields: WireName[] = []
	const entries = new Map<Finding, { readonly at: CanonicalKey; readonly name: WireName }>()
	let requirement: Requirement | undefined
	for (const input of inputs.success) {
		const result = yield* formRule(ctx, input)
		for (const finding of result.findings) {
			findings.push(finding)
		}

		if (result.rule !== undefined) {
			rules.push(result.rule)
			continue
		}

		if (!fields || schema === undefined || input.target.kind !== "property") {
			return refusedFormParts(findings)
		}

		requirement ??= yield* requirementOf(ctx.walk, schema)
		if (isRequired(requirement, input.target.name)) {
			return refusedFormParts(findings)
		}

		refusedFields.push(input.target.name)
		for (const finding of result.findings) {
			if (finding.drops === true) {
				entries.set(finding, { at: input.actual, name: input.target.name })
			}
		}
	}

	return {
		...noParts,
		encoding: rules,
		findings: Arr.map(findings, (finding) => {
			const entry = entries.get(finding)

			return entry === undefined ? finding : fieldRefusal(entry.at, finding, entry.name)
		}),
		refusedFields
	}
})

const ignoredParts = (line: SpecLine, media: Media): Parts => {
	const { home, node } = media
	const present = Arr.some(
		[node.encoding, node.prefixEncoding, node.itemEncoding],
		(member) => member !== undefined
	)

	return present ? { ...noParts, findings: [encodingIgnored(line, home)] } : noParts
}

/**
 * The part rules of an alternative: multipart and form-urlencoded read their encoding fields; any
 * other codec ignores them.
 */
const partsOf = (ctx: Context, media: Media, base: string, codec: Codec): Effect.Effect<Parts> => {
	if (codec === "multipart") {
		return multipartParts(ctx, media, base)
	}

	return codec === "form"
		? formParts(ctx, media, true)
		: Effect.succeed(ignoredParts(ctx.line, media))
}

const normalizeAlternative = Effect.fnUntraced(function* normalizeAlternative(
	ctx: Context,
	body: CanonicalKey,
	key: string
): Effect.fn.Return<AlternativeResult, BodyNotReadable> {
	const { line, resolution } = ctx
	const mediaSite = childKey(body, "content", key)
	if (!isMediaRange(key)) {
		return stopAlternative([])
	}

	const base = mediaEssence(key)
	const codec = codecOf(base)
	const media = yield* readMedia(resolution, mediaSite)
	const { home, node } = media
	const parts = yield* partsOf(ctx, media, base, codec)
	if (parts.refused) {
		return stopAlternative(anchorDrops(home, parts.findings))
	}

	/**
	 * An XML body is opaque, so its schema is never consulted (design 6.3, D-SCH3).
	 */
	const opaque = codec === "xml"
	const schemaSites = opaque
		? []
		: Arr.flatMap(["schema", "itemSchema"] as const, (field) =>
				node[field] === undefined ? [] : [childKey(home, field)]
			)
	if (Arr.some(schemaSites, (site) => appliesDynamicKeyword(resolution, site))) {
		return stopAlternative([])
	}

	const result: PlainAlternative = {
		codec,
		encoding: parts.encoding,
		mediaType: key,
		origin: yield* originOf(home),
		prefixEncoding: parts.prefixEncoding,
		rows: alternativeRows(
			line,
			codec,
			node,
			node.schema !== undefined && !opaque,
			node.itemSchema !== undefined && !opaque
		)
	}
	if (node.schema !== undefined && !opaque) {
		result.schema = { key: schemaKeyAt(resolution, childKey(home, "schema")) }
	}

	if (node.itemSchema !== undefined && !opaque) {
		result.itemSchema = { key: schemaKeyAt(resolution, childKey(home, "itemSchema")) }
	}

	if (parts.itemEncoding !== undefined) {
		result.itemEncoding = parts.itemEncoding
	}

	if (parts.refusedFields.length > 0) {
		result.refusedFields = parts.refusedFields
	}

	const described = line === "3.2" && node.description !== undefined

	return {
		alternative: result,
		findings: described ? [...parts.findings, descriptionIgnored(home)] : parts.findings
	}
})

/**
 * Where `at` sits below the content entry `mediaSite` when that entry is a reference, as a 3.2
 * `components/mediaTypes` one is: the same path under the entry instead of under its target. Undefined
 * when the entry is no reference or `at` lies outside its target.
 */
const underMediaSite = (
	resolution: Resolution,
	mediaSite: CanonicalKey,
	at: CanonicalKey
): Option.Option<CanonicalKey> => {
	const home = follow(resolution, mediaSite)
	const below = isPointerWithin(home.pointer, at.pointer)
	if (keyOf(home) === keyOf(mediaSite) || at.document !== home.document || !below) {
		return Option.none()
	}

	return Option.some({
		document: mediaSite.document,
		pointer: `${mediaSite.pointer}${Str.slice(home.pointer.length)(at.pointer)}`
	})
}

/**
 * The use site is the operation's request body; when it is a reference, the element's own
 * location in the target is `related[0]` (design 8.1). Otherwise the element names its own
 * location, in whichever document of the set holds it. Under a content entry `mediaSite` that is a
 * reference, the use site is that entry: inline, the element sits below it with its location in the
 * target as `related[0]`; under a referenced body, the same place below the body's entry follows
 * `related[0]`, so the media key stays known.
 */
const toDiagnostics = (
	ctx: Context,
	findings: readonly Finding[],
	mediaSite: Option.Option<CanonicalKey>
): Effect.Effect<readonly Diagnostic[]> =>
	Effect.forEach(findings, (item) => {
		const viaEntry = Option.flatMap(mediaSite, (entry) =>
			underMediaSite(ctx.resolution, entry, item.at)
		)
		const own = Option.getOrElse(viaEntry, () => item.at)
		/**
		 * Placed away from its own location, the element names it first; under a referenced body,
		 * the same place below the body's content entry follows.
		 */
		const moved = ctx.reference !== undefined || Option.isSome(viaEntry)
		const bodyEntry = ctx.reference === undefined ? [] : Option.toArray(viaEntry)
		const related = [...(moved ? [item.at] : []), ...bodyEntry, ...(item.related ?? [])]

		return makeDiagnostic({
			code: item.code,
			document: ctx.reference === undefined ? own.document : ctx.resolution.document,
			element: item.element,
			hint: item.hint,
			message: item.message,
			openapi: ctx.site.openapi,
			operation: ctx.site.operation,
			pointer: ctx.reference === undefined ? own.pointer : ctx.site.pointer,
			related: related.length > 0 ? related : undefined,
			scope: item.scope ?? "element",
			severity: item.severity,
			specSection: specSectionUrl(ctx.line, item.anchor),
			wire: item.wire
		})
	}).pipe(Effect.orDie)

const emptyContent = (line: SpecLine, at: CanonicalKey): Finding =>
	plainRefusal(
		"RQB-07/empty-content",
		line === "3.0" ? "request-body-object" : "request-body-content",
		"Request body content",
		"The request body declares no media type, so nothing can be sent.",
		at
	)

/**
 * What a discriminator hint reads of a schema: its compositions and its Discriminator Object, whose
 * `propertyName` is never empty.
 */
interface Discriminated {
	readonly anyOf: ReadonlyArray<unknown> | undefined
	readonly discriminator: {
		readonly mapping: Readonly<Record<string, unknown>> | undefined
		readonly propertyName: string
	}
	readonly oneOf: ReadonlyArray<unknown> | undefined
}

const discriminatorObject: Read.Reader<Discriminated["discriminator"]> = (value) =>
	Result.flatMap(Read.members(value), (object) =>
		Read.struct(
			object,
			{
				mapping: optional(object, "mapping", Read.record(Read.string, Read.anything)),
				propertyName: Read.member(
					object,
					"propertyName",
					Read.check(Read.string, Str.isNonEmpty, "a non-empty string")
				)
			},
			Read.anything
		)
	)

const discriminated: Read.Reader<Discriminated> = (value) =>
	Result.flatMap(Read.members(value), (object) =>
		Read.struct(
			object,
			{
				anyOf: optional(object, "anyOf", Read.array(Read.anything)),
				discriminator: Read.member(object, "discriminator", discriminatorObject),
				oneOf: optional(object, "oneOf", Read.array(Read.anything))
			},
			Read.anything
		)
	)

type Branch = DiscriminatorHint["branches"][number]

/**
 * Whether an element-scope refusal of check names the Discriminator Object of `root`: DSC-03,
 * 04, 05, 09 and 10 all sit at or below it, so none is listed by code.
 */
const discriminatorRefused = (findings: readonly Diagnostic[], root: CanonicalKey): boolean => {
	const at = childPointer(root.pointer, "discriminator")

	return Arr.some(
		findings,
		(finding) =>
			finding.severity === "refusal" &&
			finding.scope === "element" &&
			finding.document === root.document &&
			isPointerWithin(at, finding.pointer)
	)
}

interface Component {
	readonly key: CanonicalKey
	readonly name: string
}

/**
 * The entry's component schemas, in document key order.
 */
const entrySchemas = (resolution: Resolution): readonly Component[] => {
	const names = pipe(
		Read.members(resolution.value),
		Result.flatMap((root) => Read.member(root, "components", Read.members)),
		Result.flatMap((components) => Read.member(components, "schemas", Read.members)),
		Result.match({ onFailure: (): ReadonlyArray<string> => [], onSuccess: Record.keys })
	)

	return Arr.map(names, (name) => ({
		key: { document: resolution.document, pointer: formatPointer(["components", "schemas", name]) },
		name
	}))
}

/**
 * The `/allOf/<i>` step that ends a referring site's pointer.
 */
const allOfMember = regex("/allOf/\\d+$", "u")

/**
 * The entry components whose own `allOf[<i>]` references `root` directly (DSC-11).
 */
const allOfChildren = (
	resolution: Resolution,
	components: readonly Component[],
	root: CanonicalKey
): readonly CanonicalKey[] => {
	const parents = new Set(
		Arr.map(allOfReferrers(resolution).get(keyOf(root)) ?? [], (site) =>
			keyOf({ document: site.document, pointer: Str.replace(allOfMember, "")(site.pointer) })
		)
	)

	return Arr.flatMap(components, (component) =>
		parents.has(keyOf(component.key)) ? [component.key] : []
	)
}

/**
 * The composition that lists the branches itself: `oneOf` wins over `anyOf`.
 */
const listedKeyword = (node: Discriminated): "anyOf" | "oneOf" | undefined => {
	if ((node.oneOf ?? []).length > 0) {
		return "oneOf"
	}

	return (node.anyOf ?? []).length > 0 ? "anyOf" : undefined
}

/**
 * The usable discriminator of the schema at `site`, after its `$ref` chain; none when check
 * refused it or no branch is found.
 */
const hintAt = (
	resolution: Resolution,
	site: CanonicalKey,
	checkFindings: readonly Diagnostic[]
): DiscriminatorHint | undefined => {
	const root = settle(resolution, site)
	const node = Option.getOrUndefined(
		Option.flatMap(nodeOption(resolution, root), (json) => Result.getSuccess(discriminated(json)))
	)
	if (node === undefined || discriminatorRefused(checkFindings, root)) {
		return undefined
	}

	const components = entrySchemas(resolution)
	const names = new Map(Arr.map(components, (component) => [keyOf(component.key), component.name]))
	const listed = listedKeyword(node)
	const targets =
		listed === undefined
			? allOfChildren(resolution, components, root)
			: Arr.map(node[listed] ?? [], (_, index) =>
					settle(resolution, childKey(root, listed, String(index)))
				)
	const mapped = Arr.flatMap(Record.toEntries(node.discriminator.mapping ?? {}), ([label, value]) =>
		Predicate.isString(value)
			? Option.match(implicitComponent(resolution, "schemas", value), {
					onNone: () => [],
					onSome: (key) => [[keyOf(key), label] as const]
				})
			: []
	)
	const branches = Arr.map(targets, (target, index): Branch => {
		const key = keyOf(target)
		const component = names.get(key)
		const labels = Arr.flatMap(mapped, ([at, label]) => (at === key ? [label] : []))

		return component === undefined
			? { index, labels }
			: { component, index, labels: labels.length === 0 ? [component] : labels }
	})

	return branches.length === 0
		? undefined
		: {
				branches,
				keyword: listed ?? "allOf",
				propertyName: node.discriminator.propertyName
			}
}

/**
 * Adds the discriminator hint to each alternative of a request body whose root schema, after its
 * `$ref` chain, has a usable discriminator (design D-OQ9): the composition keyword, the property,
 * and the branches in composition order, each labeled by the mapping keys that target it, else by
 * its entry component name (implicit mapping); an inline branch has no label. With no `oneOf` or
 * `anyOf`, the branches are the entry components whose `allOf` references the schema (DSC-11). A
 * discriminator any element-scope refusal in `checkFindings` names gets no hint. The hint never
 * changes validation (DSC-06).
 */
export const hintDiscriminators = (
	resolution: Resolution,
	body: Body,
	checkFindings: readonly Diagnostic[]
): Body => {
	const hints = Arr.map(body.alternatives, (alternative) =>
		alternative.schema === undefined
			? undefined
			: hintAt(resolution, childKey(alternative.origin, "schema"), checkFindings)
	)
	if (Arr.every(hints, (found) => found === undefined)) {
		return body
	}

	return {
		...body,
		alternatives: Arr.map(body.alternatives, (alternative, index) => {
			const found = hints[index]

			return found === undefined ? alternative : { ...alternative, discriminator: found }
		})
	}
}

/**
 * Normalizes one Request Body Object into a `Body` whose alternatives are the media types that
 * survive, with element-scope refusals and notices for the rest (design 2.2, 6.3, 6.6). Codecs
 * follow the media type; encoding defaults follow the line's table; form-urlencoded and multipart
 * bodies take a rule per property; XML stays opaque; undecided constructs are refused rather than
 * dropped. A site the earlier stages should have stopped fails with `BodyNotReadable`.
 */
export const normalizeBody = Effect.fnUntraced(function* normalizeBody(
	resolution: Resolution,
	site: BodySite
): Effect.fn.Return<BodyOutcome, BodyNotReadable> {
	const use = { document: resolution.document, pointer: site.pointer }
	const reference = referenceIn(resolution, use)
	const target = follow(resolution, use)
	const node = yield* nodeIn(resolution, target).pipe(
		Effect.flatMap((json) => Effect.fromResult(requestBodyObject(json))),
		Effect.mapError(
			() => new BodyNotReadable({ pointer: site.pointer, reason: "not-a-request-body" })
		)
	)
	const walk: Walk = { resolution, site }
	const ctx: Context = { line: resolution.line, reference, resolution, site, walk }
	const required = node.required ?? false
	const keys = Record.keys(node.content)
	if (keys.length === 0) {
		const empty = emptyContent(resolution.line, childKey(target, "content"))
		const diagnostics = yield* toDiagnostics(ctx, [empty], Option.none())

		return BodyOutcome.Refused({ diagnostics, required })
	}

	const results = yield* Effect.forEach(keys, (key) => normalizeAlternative(ctx, target, key))
	const placed = yield* Effect.forEach(results, (result, index) =>
		toDiagnostics(ctx, result.findings, Option.some(childKey(target, "content", keys[index] ?? "")))
	)
	const diagnostics = placed.flat()
	const alternatives = Arr.getSomes(
		Arr.map(results, (result) => Option.fromUndefinedOr(result.alternative))
	)
	if (alternatives.length === 0) {
		return BodyOutcome.Refused({ diagnostics, required })
	}

	const body: Body = {
		alternatives,
		docs: docsOf(reference?.description ?? node.description, reference?.summary),
		origin: yield* originOf(use),
		required,
		rows: ["RQB-01", "RQB-03", "RQB-04"]
	}

	return BodyOutcome.Implemented({ body, diagnostics })
})

/**
 * What the form rules decided for one form-urlencoded content entry outside a request body.
 * `Implemented` holds one rule per declared property in document order; `Refused` means a rule
 * refused the entry, as it would drop a form body alternative.
 */
export type FormContentOutcome = Data.TaggedEnum<{
	Implemented: {
		readonly diagnostics: readonly Diagnostic[]
		readonly encoding: readonly EncodingRule[]
	}
	Refused: { readonly diagnostics: readonly Diagnostic[] }
}>

/**
 * Constructors and dispatch for {@link FormContentOutcome}.
 */
export const FormContentOutcome = Data.taggedEnum<FormContentOutcome>()

/**
 * The form-urlencoded rules of the content entry `mediaType` of the element at `site`, decided
 * exactly as a form body alternative's are (design 6.1, 6.3), for a 3.2 `querystring` parameter
 * whose form content takes Encoding Objects "as for bodies". Content of any other media type has
 * no rules. Diagnostics are placed as a body's are, at `site` when the element is a reference.
 */
export const formContentRules = Effect.fnUntraced(function* formContentRules(
	resolution: Resolution,
	site: BodySite,
	mediaType: string
): Effect.fn.Return<FormContentOutcome, BodyNotReadable> {
	if (codecOf(mediaEssence(mediaType)) !== "form") {
		return FormContentOutcome.Implemented({ diagnostics: [], encoding: [] })
	}

	const use = { document: resolution.document, pointer: site.pointer }
	const reference = referenceIn(resolution, use)
	const walk: Walk = { resolution, site }
	const ctx: Context = { line: resolution.line, reference, resolution, site, walk }
	const mediaSite = childKey(follow(resolution, use), "content", mediaType)
	const media = yield* readMedia(resolution, mediaSite)
	const parts = yield* formParts(ctx, media, false)
	if (parts.refused) {
		const refused = yield* toDiagnostics(
			ctx,
			anchorDrops(media.home, parts.findings),
			Option.some(mediaSite)
		)

		return FormContentOutcome.Refused({ diagnostics: refused })
	}

	const diagnostics = yield* toDiagnostics(ctx, parts.findings, Option.some(mediaSite))
	const encoding: ReadonlyArray<EncodingRule> = parts.encoding

	return FormContentOutcome.Implemented({ diagnostics, encoding })
})
