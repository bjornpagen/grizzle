import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Order, Record, Result, String as Str } from "effect"
import { isHeaderName, isMediaRange } from "#model/brands.ts"
import { makeDiagnostic } from "#model/diagnostic.ts"
import type { Diagnostic, DiagnosticOperation } from "#model/diagnostic.ts"
import type { MediaAlternative, ResponseCase, RowId } from "#model/entities.ts"
import { isSpecificationExtension } from "#model/extension.ts"
import { stringMember } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { declaredOpenapi, specSectionUrl } from "#model/spec-section.ts"
import { docsOf } from "#normalize/docs.ts"
import {
	childKey,
	follow,
	memberNamesAt,
	objectIn,
	originOf,
	referenceIn
} from "#normalize/document-set.ts"
import { readEventContract } from "#normalize/event-stream.ts"
import { headerMarks } from "#normalize/header-object.ts"
import { headerPercentEncoding } from "#normalize/parameters.ts"
import { defsKey } from "#resolve/canonical.ts"
import type { CanonicalKey } from "#resolve/canonical.ts"
import type { Resolution, ResolvedReference } from "#resolve/index.ts"
import { mediaEssence, sequentialCodecOf } from "#runtime-src/runtime/sequential.ts"

/**
 * The response cases of one Responses Object and the diagnostics found while building them.
 */
export interface NormalizedResponses {
	readonly diagnostics: readonly Diagnostic[]
	readonly responses: readonly ResponseCase[]
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
	"HDR-15/header-percent-encoding": {
		anchor: "appendix-d-serializing-headers-and-cookies",
		element: "Response header percent-encoding",
		message: headerPercentEncoding,
		scope: "element",
		severity: "notice"
	},
	"MED-09/description-ignored": {
		anchor: "media-type-object",
		element: "Media type description",
		message: "The description of a media type is not used, so it is ignored here.",
		scope: "element",
		severity: "notice"
	},
	"MED-10/encoding-ignored": {
		anchor: "media-type-encoding",
		element: "Media type encoding",
		message:
			"The encoding field applies to multipart and form-urlencoded request bodies only, so it is ignored here.",
		scope: "element",
		severity: "notice"
	},
	"MED-18/stream-event-twice": {
		anchor: "special-considerations-for-server-sent-events",
		element: "Event stream item union",
		hint: "Name each event in one branch of the itemSchema union.",
		message:
			"Two branches of an event stream's itemSchema name one event and differ in its data or its x-stream role; the operation is refused.",
		scope: "operation",
		severity: "refusal"
	},
	"MED-18/stream-retry-not-json": {
		anchor: "special-considerations-for-server-sent-events",
		element: "Event stream role",
		hint: "Give the event's data property contentMediaType application/json, or drop retryWhen.",
		message:
			"An x-stream retryWhen points into an event's data, which its schema does not declare as JSON; the operation is refused.",
		scope: "operation",
		severity: "refusal"
	},
	"MED-18/stream-role-invalid": {
		anchor: "special-considerations-for-server-sent-events",
		element: "Event stream role",
		hint: 'Write {"role":"ready"}, {"role":"end"}, {"role":"error"} or {"role":"error","retryWhen":{"pointer":...,"equals":...}}.',
		message:
			"An x-stream annotation is not one of its forms, so the stream's stopping point is unknown; the operation is refused.",
		scope: "operation",
		severity: "refusal"
	},
	"MED-18/stream-role-unnamed": {
		anchor: "special-considerations-for-server-sent-events",
		element: "Event stream role",
		hint: "Give the branch's event property a const event name.",
		message:
			"An x-stream role sits on an itemSchema branch that names no event, so no event can take the role; the operation is refused.",
		scope: "operation",
		severity: "refusal"
	},
	"RSP-05/invalid-media-type": {
		anchor: "response-content",
		element: "Response content key",
		message: "A content key is not a media type or a media range; the alternative is refused.",
		scope: "element",
		severity: "refusal"
	},
	"RSP-09/ignored-content-type": {
		anchor: "response-headers",
		element: "Response header",
		message: "A response header named Content-Type is ignored.",
		scope: "element",
		severity: "notice"
	},
	"RSP-09/invalid-header-name": {
		anchor: "response-headers",
		element: "Response header",
		message: "A response header name is not an RFC 9110 token; the header is refused.",
		scope: "element",
		severity: "refusal"
	},
	"RSS-06/invalid-key": {
		anchor: "responses-code",
		element: "Response key",
		hint: "Use a status code, a range from 1XX to 5XX with an uppercase X, or default.",
		message:
			"A responses key is not a status code, a status range or default; the response is refused.",
		scope: "element",
		severity: "refusal"
	},
	"RSS-10/status-out-of-range": {
		anchor: "responses-code",
		element: "Response key",
		hint: "Status codes run from 100 to 599.",
		message: "A status code outside 100 to 599 is refused.",
		scope: "element",
		severity: "refusal"
	}
} as const satisfies Record<string, Rule>

type Code = keyof typeof rules

/**
 * A finding at its own location, in whichever document of the set holds it.
 */
interface Finding {
	readonly at: CanonicalKey
	readonly code: Code
}

/**
 * A built value with the findings raised while building it, in the order they were raised.
 */
interface Built<A> {
	readonly findings: readonly Finding[]
	readonly value: A
}

const schemaRefAt = (resolution: Resolution, site: CanonicalKey) => {
	const reference = referenceIn(resolution, site)
	const key =
		reference === undefined
			? defsKey(resolution.document, site)
			: (reference.defsKey ?? defsKey(resolution.document, reference.target))

	return { key }
}

/**
 * A Responses Object member, by its name: a case under its response key, an `x-` member left to NZ-5, or a name
 * refused with its finding's code.
 */
type Member =
	| { readonly _tag: "Case"; readonly key: ResponseCase["key"] }
	| { readonly _tag: "Extension" }
	| { readonly _tag: "Refused"; readonly code: "RSS-06/invalid-key" | "RSS-10/status-out-of-range" }

/**
 * A range key, `1XX` to `5XX` with an uppercase X, its class digit captured.
 */
const rangeKey = regex("^(?<digit>[1-5])XX$", "u")

/**
 * A status code key, 100 to 599.
 */
const codeKey = regex("^[1-5][0-9]{2}$", "u")

/**
 * A three-digit key, whatever its value: one that is no code from 100 to 599 is out of range
 * (RSS-10) rather than outside the grammar (RSS-06).
 */
const statusDigits = regex("^[0-9]{3}$", "u")

/**
 * Classify one Responses Object member name by the response key grammar: `default`, a range `1XX`
 * to `5XX` or a code from 100 to 599 is a case under its key; otherwise a three-digit code is out
 * of range (RSS-10), an `x-` name an extension, and any other name outside the grammar (RSS-06).
 */
const classifyKey = (text: string): Member => {
	if (text === "default") {
		return { _tag: "Case", key: "default" }
	}

	const range = rangeKey.exec(text)?.groups.digit
	if (range !== undefined) {
		return { _tag: "Case", key: { range: Number(range) } }
	}

	if (codeKey.test(text)) {
		return { _tag: "Case", key: { code: Number(text) } }
	}

	if (statusDigits.test(text)) {
		return { _tag: "Refused", code: "RSS-10/status-out-of-range" }
	}

	return isSpecificationExtension(text)
		? { _tag: "Extension" }
		: { _tag: "Refused", code: "RSS-06/invalid-key" }
}

type Codec = MediaAlternative["codec"]

/**
 * The codec follows the media type alone, never the schema (design 2.2); a range, or a type no
 * other family claims, is bytes. It differs from the request body codec on `text/*` and
 * `+json-seq` by design.
 */
const codecOf = (mediaType: string): Codec => {
	const sequential = sequentialCodecOf(mediaType)
	if (sequential !== undefined) {
		return sequential
	}

	const essence = mediaEssence(mediaType)

	if (essence === "application/json" || Str.endsWith("+json")(essence)) {
		return "json"
	}

	if (essence === "application/xml" || essence === "text/xml" || Str.endsWith("+xml")(essence)) {
		return "xml"
	}

	if (essence === "application/x-www-form-urlencoded") {
		return "form"
	}

	if (Str.startsWith("multipart/")(essence)) {
		return "multipart"
	}

	return Str.startsWith("text/")(essence) && !Str.endsWith("/*")(essence) ? "text" : "binary"
}

/**
 * What a response key's form fixes: its row (RSS-02 for `default`, RSS-03 for a code, RSS-06 for a
 * range) and its place in the matching order, explicit codes, then ranges, then `default` (design
 * 7.3), a code or a range by its number.
 */
interface Place {
	readonly rank: number
	readonly row: RowId
	readonly value: number
}

const placeOf = (key: ResponseCase["key"]): Place => {
	if (key === "default") {
		return { rank: 2, row: "RSS-02", value: 0 }
	}

	return "code" in key
		? { rank: 0, row: "RSS-03", value: key.code }
		: { rank: 1, row: "RSS-06", value: key.range }
}

/**
 * One media alternative of a response, under its content key, or none when the key is no media
 * type or range (RSP-05). Encoding applies to request bodies only (MED-10, 3.0 and 3.1), and a 3.2
 * Media Type description is unused (MED-09, D-OC5), so each is ignored with a notice. A
 * `text/event-stream` alternative with an item schema carries the event contract that schema
 * states; a contract that cannot be read is a finding.
 */
const alternativeOf = Effect.fnUntraced(function* alternativeOf(
	resolution: Resolution,
	response: CanonicalKey,
	mediaType: string
): Effect.fn.Return<Built<Option.Option<MediaAlternative>>> {
	const site = childKey(response, "content", mediaType)
	if (!isMediaRange(mediaType)) {
		return { findings: [{ at: site, code: "RSP-05/invalid-media-type" }], value: Option.none() }
	}

	const home = follow(resolution, site)
	const media = yield* objectIn(resolution, home)
	const findings: readonly Finding[] = [
		...(Record.has(media, "encoding") && resolution.line !== "3.2"
			? [{ at: home, code: "MED-10/encoding-ignored" } as const]
			: []),
		...(Record.has(media, "description") && resolution.line === "3.2"
			? [{ at: home, code: "MED-09/description-ignored" } as const]
			: [])
	]
	const plain: MediaAlternative = {
		codec: codecOf(mediaType),
		encoding: [],
		mediaType,
		origin: yield* originOf(home),
		prefixEncoding: [],
		rows: ["RSP-05"],
		...(Record.has(media, "itemSchema")
			? { itemSchema: schemaRefAt(resolution, childKey(home, "itemSchema")) }
			: {}),
		...(Record.has(media, "schema")
			? { schema: schemaRefAt(resolution, childKey(home, "schema")) }
			: {})
	}
	const contract =
		plain.codec === "sse" && Record.has(media, "itemSchema")
			? readEventContract(resolution, childKey(home, "itemSchema"))
			: Result.succeed(Option.none())
	if (Result.isFailure(contract)) {
		return { findings: [...findings, contract.failure], value: Option.some(plain) }
	}

	return {
		findings,
		value: Option.some(
			Option.match(contract.success, {
				onNone: () => plain,
				onSome: (events) => ({ ...plain, events })
			})
		)
	}
})

/**
 * Whether the header at `at` is serialized by a schema: a 3.0 such header carries the D-OC9
 * notice, and a content-based one never was percent-encoded.
 */
const serializedBySchema = (resolution: Resolution, at: CanonicalKey): Effect.Effect<boolean> =>
	Effect.map(objectIn(resolution, follow(resolution, at)), (header) => Record.has(header, "schema"))

const headerOf = Effect.fnUntraced(function* headerOf(
	resolution: Resolution,
	response: CanonicalKey,
	name: string
): Effect.fn.Return<Built<Option.Option<ResponseCase["headers"][number]>>> {
	const at = childKey(response, "headers", name)
	if (Str.toLowerCase(name) === "content-type") {
		return { findings: [{ at, code: "RSP-09/ignored-content-type" }], value: Option.none() }
	}

	if (!isHeaderName(name)) {
		return { findings: [{ at, code: "RSP-09/invalid-header-name" }], value: Option.none() }
	}

	const header = { name, ...(yield* headerMarks(resolution, at)) }
	const encoded = resolution.line === "3.0" && (yield* serializedBySchema(resolution, at))

	return {
		findings: encoded ? [{ at, code: "HDR-15/header-percent-encoding" }] : [],
		value: Option.some(header)
	}
})

const headersOf = Effect.fnUntraced(function* headersOf(
	resolution: Resolution,
	headers: readonly string[],
	response: CanonicalKey
): Effect.fn.Return<Built<ResponseCase["headers"]>> {
	const built = yield* Effect.forEach(headers, (name) => headerOf(resolution, response, name))

	return {
		findings: Arr.flatMap(built, (header) => header.findings),
		value: Arr.getSomes(Arr.map(built, (header) => header.value))
	}
})

/**
 * A case's help text: its description and summary, a Reference Object's at the use site over the
 * Response Object's own, each made safe.
 */
const caseDocsOf = (
	response: JsonObject,
	site: ResolvedReference | undefined
): ResponseCase["docs"] =>
	docsOf(
		site?.description ?? stringMember(response, "description"),
		site?.summary ?? stringMember(response, "summary")
	)

/**
 * The case of the Responses Object member `text` under its key, read where its `$ref` leads: its
 * media alternatives and headers in member order. A response without `content` describes no body
 * (RSP-07); one with it, its media types (RSP-05).
 */
const caseOf = Effect.fnUntraced(function* caseOf(
	resolution: Resolution,
	responses: CanonicalKey,
	text: string,
	key: ResponseCase["key"]
): Effect.fn.Return<Built<ResponseCase>> {
	const site = childKey(responses, text)
	const home = follow(resolution, site)
	const response = yield* objectIn(resolution, home)
	const content = yield* memberNamesAt(resolution, childKey(home, "content"))
	const alternatives = yield* Effect.forEach(Option.getOrElse(content, Arr.empty), (mediaType) =>
		alternativeOf(resolution, home, mediaType)
	)
	const headerNames = yield* memberNamesAt(resolution, childKey(home, "headers"))
	const headers = yield* headersOf(resolution, Option.getOrElse(headerNames, Arr.empty), home)
	const rows: readonly RowId[] = [
		placeOf(key).row,
		"RSP-01",
		...(headers.value.length === 0 ? [] : (["RSP-04"] as const)),
		Option.isNone(content) ? "RSP-07" : "RSP-05"
	]

	return {
		findings: [
			...Arr.flatMap(alternatives, (alternative) => alternative.findings),
			...headers.findings
		],
		value: {
			alternatives: Arr.getSomes(Arr.map(alternatives, (alternative) => alternative.value)),
			docs: caseDocsOf(response, referenceIn(resolution, site)),
			headers: headers.value,
			key,
			origin: yield* originOf(site),
			rows
		}
	}
})

/**
 * The diagnostic of a finding: an operation-scope refusal names the operation it omits.
 */
const toDiagnostic = (
	resolution: Resolution,
	finding: Finding,
	operation: DiagnosticOperation
): Effect.Effect<Diagnostic> => {
	const rule: Rule = rules[finding.code]
	const openapi = Option.getOrElse(declaredOpenapi(resolution.value), () => "unknown")

	return makeDiagnostic({
		code: finding.code,
		document: finding.at.document,
		element: rule.element,
		hint: rule.hint,
		message: rule.message,
		openapi,
		operation: rule.scope === "operation" ? operation : undefined,
		pointer: finding.at.pointer,
		scope: rule.scope,
		severity: rule.severity,
		specSection: specSectionUrl(resolution.line, rule.anchor)
	})
}

/**
 * One member of a Responses Object: a case, a refused key, or an `x-` key left to NZ-5.
 */
const entryOf = Effect.fnUntraced(function* entryOf(
	resolution: Resolution,
	responses: CanonicalKey,
	text: string
): Effect.fn.Return<Built<Option.Option<ResponseCase>>> {
	const member = classifyKey(text)
	switch (member._tag) {
		case "Refused": {
			return {
				findings: [{ at: childKey(responses, text), code: member.code }],
				value: Option.none()
			}
		}
		case "Extension": {
			return { findings: [], value: Option.none() }
		}
		case "Case": {
			const built = yield* caseOf(resolution, responses, text, member.key)

			return { findings: built.findings, value: Option.some(built.value) }
		}
	}
})

/**
 * Builds the `ResponseCase` list of the Responses Object at `pointer` in the entry document, in
 * member order (design 2.2, 6.6, 7.3; JavaScript lists integer-like keys such as `200` first,
 * ascending). A key is an explicit code, a range `1XX` to `5XX` or `default`; a key outside that
 * grammar, a code outside 100 to 599, a content key that is no media type and a header name that is
 * no token are refused at element scope, and a `Content-Type` header is ignored with a notice
 * (`RSP-09`). Headers are recorded by name with their `required` and `deprecated` marks, read
 * through a `$ref`; they never change stdout or the exit status. A 3.0 schema-serialized header
 * gets a notice that its value is not percent-decoded (`HDR-15`). An absent Responses Object has no
 * cases, and `x-` keys are NZ-5's to account for. Schemas are referenced by `$defs` key, an inline
 * one by `defsKey` of its canonical pointer. A response or media type a reference takes into
 * another document of the set is read there, and its findings name that document.
 */
export const normalizeResponses = Effect.fnUntraced(function* normalizeResponses(
	resolution: Resolution,
	pointer: string,
	operation: DiagnosticOperation
): Effect.fn.Return<NormalizedResponses> {
	const responses = { document: resolution.document, pointer }
	const keys = yield* memberNamesAt(resolution, responses)
	const entries = yield* Effect.forEach(Option.getOrElse(keys, Arr.empty), (text) =>
		entryOf(resolution, responses, text)
	)
	const findings = Arr.flatMap(entries, (entry) => entry.findings)
	const cases = Arr.getSomes(Arr.map(entries, (entry) => entry.value))

	return {
		diagnostics: yield* Effect.forEach(findings, (finding) =>
			toDiagnostic(resolution, finding, operation)
		),
		responses: cases
	}
})

const precedence = Order.combine(
	Order.mapInput(Order.Number, (response: ResponseCase) => placeOf(response.key).rank),
	Order.mapInput(Order.Number, (response: ResponseCase) => placeOf(response.key).value)
)

/**
 * The matching order of the cases: explicit codes, then ranges, then `default` (design 7.3).
 */
export const precedenceOrder = (cases: readonly ResponseCase[]): readonly ResponseCase[] =>
	Arr.sort(cases, precedence)

const specificity = (alternative: MediaAlternative): number => {
	const essence = mediaEssence(alternative.mediaType)
	if (essence === "*/*") {
		return 2
	}

	return Str.endsWith("/*")(essence) ? 1 : 0
}

/**
 * The order a response media type is looked up in: exact keys, then a type range, then the full
 * range, each in document order (design 6.6; `T30#response-content`).
 */
export const dispatchOrder = (
	alternatives: readonly MediaAlternative[]
): readonly MediaAlternative[] => Arr.sort(alternatives, Order.mapInput(Order.Number, specificity))
