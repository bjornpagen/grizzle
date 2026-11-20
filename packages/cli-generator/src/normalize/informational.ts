import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Order, Predicate, Record, Schema } from "effect"
import { Informational } from "#model/entities.ts"
import { isSpecificationExtension } from "#model/extension.ts"
import { isObject, isArray } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { methodMembers } from "#model/path-item.ts"
import { childPointer } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"
import type { Resolution } from "#resolve/index.ts"

const reasons = {
	"CBK-01": "A callback describes a request the provider sends; a client never sends it.",
	"DOC-08": "A webhook describes a request the provider sends; a client never sends it.",
	"EXD-01": "External documentation is a link for readers; it is never fetched.",
	"EXM-01": "An example is documentation; it is never sent and never a default.",
	"EXT-01": "A specification extension is read and recorded; it never changes a request.",
	"EXT-02":
		"A reserved x-oai- or x-oas- extension is read and recorded; it never changes a request.",
	"INF-01": "Info is metadata for help and the README; it is never sent.",
	"INF-09": "Contact is metadata; it is never sent.",
	"INF-13": "License is metadata; it is never sent.",
	"LNK-01": "A link is a design-time relation between operations; it is never followed.",
	"TAG-01": "A tag is grouping metadata for help; it never changes a request."
} as const

type Row = keyof typeof reasons

interface Finding {
	readonly pointer: string
	readonly row: Row
}

type Findings = readonly Finding[]

/**
 * The Objects that can hold informational elements. An informational Object (example, link,
 * callback) is recorded and not walked, because its record accounts for its parts.
 */
type Walked =
	| "encoding"
	| "externalDocs"
	| "flow"
	| "flows"
	| "header"
	| "mediaType"
	| "operation"
	| "parameter"
	| "pathItem"
	| "requestBody"
	| "response"
	| "responses"
	| "securityScheme"
	| "server"
	| "variable"

type Informative = "callback" | "example" | "link"

const informativeRow = {
	callback: "CBK-01",
	example: "EXM-01",
	link: "LNK-01"
} as const satisfies Record<Informative, Row>

type Edge =
	| readonly ["informative", string, Informative]
	| readonly ["list" | "map" | "one", string, Walked]

/**
 * What a walked Object holds besides its specification extensions: edges to the Objects it
 * contains, every other member as one kind of Object, or only a record of its own.
 */
type Holds =
	| { readonly _tag: "Edges"; readonly edges: readonly Edge[] }
	| { readonly _tag: "Members"; readonly kind: Walked }
	| { readonly _tag: "Recorded"; readonly row: Row }

const edges = (list: readonly Edge[]): Holds => ({ _tag: "Edges", edges: list })

const members = (kind: Walked): Holds => ({ _tag: "Members", kind })

const methodFields: readonly string[] = Arr.sort(methodMembers("3.2"), Order.String)

const holds: Readonly<Record<Walked, Holds>> = {
	encoding: edges([
		["map", "headers", "header"],
		["map", "encoding", "encoding"],
		["list", "prefixEncoding", "encoding"],
		["one", "itemEncoding", "encoding"]
	]),
	externalDocs: { _tag: "Recorded", row: "EXD-01" },
	flow: edges([]),
	flows: members("flow"),
	header: edges([
		["informative", "examples", "example"],
		["map", "content", "mediaType"]
	]),
	mediaType: edges([
		["informative", "examples", "example"],
		["map", "encoding", "encoding"],
		["list", "prefixEncoding", "encoding"],
		["one", "itemEncoding", "encoding"]
	]),
	operation: edges([
		["one", "externalDocs", "externalDocs"],
		["informative", "callbacks", "callback"],
		["list", "parameters", "parameter"],
		["one", "requestBody", "requestBody"],
		["one", "responses", "responses"],
		["list", "servers", "server"]
	]),
	parameter: edges([
		["informative", "examples", "example"],
		["map", "content", "mediaType"]
	]),
	pathItem: edges([
		["list", "servers", "server"],
		["list", "parameters", "parameter"],
		...Arr.map(methodFields, (method): Edge => ["one", method, "operation"]),
		["map", "additionalOperations", "operation"]
	]),
	requestBody: edges([["map", "content", "mediaType"]]),
	response: edges([
		["map", "headers", "header"],
		["map", "content", "mediaType"],
		["informative", "links", "link"]
	]),
	responses: members("response"),
	securityScheme: edges([["one", "flows", "flows"]]),
	server: edges([["map", "variables", "variable"]]),
	variable: edges([])
}

const componentSections = {
	callbacks: "callback",
	examples: "example",
	headers: "header",
	links: "link",
	mediaTypes: "mediaType",
	parameters: "parameter",
	pathItems: "pathItem",
	requestBodies: "requestBody",
	responses: "response",
	securitySchemes: "securityScheme"
} as const satisfies Record<string, Informative | Walked>

const infoParts = [
	["contact", "INF-09"],
	["license", "INF-13"]
] as const satisfies readonly (readonly [string, Row])[]

const reservedExtension = regex("^x-o(?:ai|as)-", "u")

const isInformative = (kind: string): kind is Informative => kind in informativeRow

const isReference = (node: JsonObject): boolean =>
	Option.exists(Record.get(node, "$ref"), Predicate.isString)

/**
 * The findings `read` makes of the member `name` of `node`, none when the member is absent.
 */
const atMember = (node: JsonObject, name: string, read: (value: Json) => Findings): Findings =>
	Option.match(Record.get(node, name), { onNone: () => [], onSome: read })

/**
 * The members of an Object other than its specification extensions, in document order.
 */
const membersOf = (node: JsonObject): readonly (readonly [string, Json])[] =>
	Arr.filter(Record.toEntries(node), ([key]) => !isSpecificationExtension(key))

const extensionsOf = (node: JsonObject, pointer: string): Findings =>
	Arr.map(Arr.filter(Record.keys(node), isSpecificationExtension), (key): Finding => ({
		pointer: childPointer(pointer, key),
		row: reservedExtension.test(key) ? "EXT-02" : "EXT-01"
	}))

/**
 * A map of names to elements of one informational kind: one record per entry, or one record at the
 * map when it is empty, so a declared but empty map is still accounted for.
 */
const informativeMap = (row: Row, value: Json, pointer: string): Findings => {
	if (!isObject(value)) {
		return []
	}

	const names = Record.keys(value)

	return Arr.isReadonlyArrayNonEmpty(names)
		? Arr.map(names, (name): Finding => ({ pointer: childPointer(pointer, name), row }))
		: [{ pointer, row }]
}

const follow = (edge: Edge, node: JsonObject, pointer: string): Findings => {
	const [how, name, target] = edge
	const site = childPointer(pointer, name)

	return atMember(node, name, (value) => {
		if (how === "informative") {
			return informativeMap(informativeRow[target], value, site)
		}

		if (how === "one") {
			return visit(target, value, site)
		}

		if (how === "list") {
			return isArray(value)
				? Arr.flatMap(value, (item, index) =>
						visit(target, item, childPointer(site, String(index)))
					)
				: []
		}

		return isObject(value)
			? Arr.flatMap(Record.toEntries(value), ([key, entry]) =>
					visit(target, entry, childPointer(site, key))
				)
			: []
	})
}

/**
 * The findings of one walked Object. A Reference Object's other members are ignored (REF rows), so
 * nothing below it is read here.
 */
const visit = (kind: Walked, value: Json, pointer: string): Findings => {
	if (!isObject(value) || isReference(value)) {
		return []
	}

	const held = holds[kind]
	const extensions = extensionsOf(value, pointer)
	switch (held._tag) {
		case "Recorded": {
			return [{ pointer, row: held.row }, ...extensions]
		}
		case "Edges": {
			return [...extensions, ...Arr.flatMap(held.edges, (edge) => follow(edge, value, pointer))]
		}
		case "Members": {
			return [
				...extensions,
				...Arr.flatMap(membersOf(value), ([key, entry]) =>
					visit(held.kind, entry, childPointer(pointer, key))
				)
			]
		}
	}
}

const infoOf = (value: Json): Findings =>
	isObject(value)
		? [
				{ pointer: "/info", row: "INF-01" },
				...extensionsOf(value, "/info"),
				...Arr.flatMap(infoParts, ([name, row]) =>
					atMember(value, name, (part) =>
						isObject(part)
							? [
									{ pointer: childPointer("/info", name), row },
									...extensionsOf(part, childPointer("/info", name))
								]
							: []
					)
				)
			]
		: []

const tagsOf = (value: Json): Findings =>
	isArray(value)
		? Arr.flatMap(value, (tag, index) => {
				if (!isObject(tag)) {
					return []
				}

				const pointer = childPointer("/tags", String(index))

				return [
					{ pointer, row: "TAG-01" },
					...extensionsOf(tag, pointer),
					...follow(["one", "externalDocs", "externalDocs"], tag, pointer)
				]
			})
		: []

const pathsOf = (value: Json): Findings =>
	isObject(value)
		? [
				...Arr.flatMap(membersOf(value), ([key, item]) =>
					visit("pathItem", item, childPointer("/paths", key))
				),
				...extensionsOf(value, "/paths")
			]
		: []

const componentsOf = (value: Json): Findings =>
	isObject(value)
		? [
				...extensionsOf(value, "/components"),
				...Arr.flatMap(Record.toEntries(componentSections), ([section, kind]) =>
					atMember(value, section, (map) => {
						const pointer = childPointer("/components", section)
						if (!isObject(map)) {
							return []
						}

						return isInformative(kind)
							? informativeMap(informativeRow[kind], map, pointer)
							: Arr.flatMap(Record.toEntries(map), ([name, entry]) =>
									visit(kind, entry, childPointer(pointer, name))
								)
					})
				)
			]
		: []

const findings = (root: JsonObject): Findings => [
	...atMember(root, "info", infoOf),
	...extensionsOf(root, ""),
	...follow(["one", "externalDocs", "externalDocs"], root, ""),
	...atMember(root, "tags", tagsOf),
	...follow(["list", "servers", "server"], root, ""),
	...atMember(root, "webhooks", (value) => informativeMap("DOC-08", value, "/webhooks")),
	...atMember(root, "paths", pathsOf),
	...atMember(root, "components", componentsOf)
]

const decode = Schema.decodeUnknownEffect(Informational)

/**
 * The elements the generator reads and counts but never sends (design 2.4, D-OQ2, D-CUS2): info,
 * contact and license; external documentation; tags; webhooks, callbacks, links and examples; and
 * specification extensions. Each is one record with its row, its use-site pointer in the entry
 * document, and a fixed reason. The walk follows the Objects that can hold them, in the fixed
 * order info, extensions, external docs, tags, servers, webhooks, paths, components, and within
 * a map in document order. An informational element is recorded and not walked further, a
 * Reference Object is recorded or skipped at its use site and never followed, and schemas are not
 * walked here (their annotations belong to the schema stage).
 */
export const collectInformational = (
	resolution: Resolution
): Effect.Effect<readonly Informational[]> =>
	isObject(resolution.value)
		? Effect.forEach(findings(resolution.value), (finding) =>
				decode({
					origin: { document: resolution.document, pointer: finding.pointer },
					reason: reasons[finding.row],
					row: finding.row
				})
			).pipe(Effect.orDie)
		: Effect.succeed([])
