import {
	Array as Arr,
	Data,
	Effect,
	HashMap,
	Option,
	Order,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import type { AuthorConfig } from "#model/author-config.ts"
import { isCookieName, isMediaType, isWireName, stripUnsafeText } from "#model/brands.ts"
import type { MediaType, WireName } from "#model/brands.ts"
import { makeDiagnostic } from "#model/diagnostic.ts"
import type { Diagnostic, DiagnosticOperation } from "#model/diagnostic.ts"
import { Parameter } from "#model/entities.ts"
import type { RowId } from "#model/entities.ts"
import { specSectionUrl } from "#model/spec-section.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { docsOf } from "#normalize/docs.ts"
import { childKey, follow, nodeOption, referenceIn } from "#normalize/document-set.ts"
import { appliesDynamicKeyword, schemaKeyAt } from "#normalize/schemas.ts"
import { keyOf } from "#resolve/canonical.ts"
import type { CanonicalKey } from "#resolve/canonical.ts"
import type { Resolution, ResolvedReference } from "#resolve/index.ts"
import {
	anything,
	array,
	boolean,
	check,
	member,
	members,
	number,
	optionalMember,
	refine,
	string,
	struct,
	union
} from "#runtime/read.ts"
import type { Members, Reader, ReadIssues } from "#runtime/read.ts"

/**
 * Where a parameter is read: its use site in the entry document, the operation it belongs to when
 * known, and the document's full `openapi` value. `nonStandard` carries the author config's opt-in
 * switches of the same name; absent is strict (design 6.1, D-OQ1).
 */
export interface ParameterSite {
	readonly nonStandard?: AuthorConfig["nonStandard"]
	readonly openapi: string
	readonly operation?: DiagnosticOperation
	readonly pointer: string
}

/**
 * What normalizing one Parameter Object produced. `Refused` keeps `required` so the operation
 * assembly can raise a refused required parameter to operation scope.
 */
export type ParameterOutcome = Data.TaggedEnum<{
	Implemented: { readonly diagnostics: readonly Diagnostic[]; readonly parameter: Parameter }
	Ignored: { readonly diagnostics: readonly Diagnostic[] }
	Refused: { readonly diagnostics: readonly Diagnostic[]; readonly required: boolean }
}>

/**
 * Constructors and dispatch for {@link ParameterOutcome}.
 */
export const ParameterOutcome = Data.taggedEnum<ParameterOutcome>()

/**
 * The site is not a Parameter Object the earlier stages could have passed: validation, resolution
 * or the structure checks should have stopped it.
 */
export class ParameterNotReadable extends Data.TaggedError("ParameterNotReadable")<{
	readonly pointer: string
	readonly reason:
		| "content-entry-count"
		| "line-mismatch"
		| "not-a-parameter"
		| "path-not-required"
		| "schema-xor-content"
}> {}

/**
 * The eight `style` values a Parameter, Header or Encoding Object may declare.
 */
export const styleNames = [
	"cookie",
	"deepObject",
	"form",
	"label",
	"matrix",
	"pipeDelimited",
	"simple",
	"spaceDelimited"
] as const

/**
 * One of the {@link styleNames}.
 */
export type StyleName = (typeof styleNames)[number]

/**
 * Whether a value is one of the {@link styleNames}.
 */
export const isStyleName = (value: unknown): value is StyleName =>
	Arr.some(styleNames, (name) => name === value)

/**
 * The five places a Parameter Object's `in` names.
 */
const locations = ["cookie", "header", "path", "query", "querystring"] as const

type Location = (typeof locations)[number]

const isLocation = (value: unknown): value is Location =>
	Arr.some(locations, (location) => location === value)

/**
 * A Header Object as normalization reads it (HDR-01: a Parameter Object without `name` and `in`):
 * each field the object lacks is `undefined`. Only `x-sensitive: true` makes it `sensitive`; any
 * other mark is read as none, so a malformed mark never refuses.
 */
interface HeaderNode {
	readonly allowEmptyValue: boolean | undefined
	readonly allowReserved: boolean | undefined
	readonly content: Members | undefined
	readonly deprecated: boolean | undefined
	readonly description: string | undefined
	readonly explode: boolean | undefined
	readonly required: boolean | undefined
	readonly schema: unknown
	readonly sensitive: boolean
	readonly style: StyleName | undefined
}

/**
 * A Parameter Object as normalization reads it: a Header Object's fields, with its `name` and `in`.
 */
interface ParameterNode extends HeaderNode {
	readonly in: Location
	readonly name: string
}

/**
 * A Header Object's fields, read from its members: a field of another type makes the object
 * unreadable, and a member it does not name is not read.
 */
const headerFields = (header: Members): Result.Result<HeaderNode, ReadIssues> =>
	Result.map(
		struct(
			header,
			{
				allowEmptyValue: optionalMember(header, "allowEmptyValue", boolean),
				allowReserved: optionalMember(header, "allowReserved", boolean),
				content: optionalMember(header, "content", members),
				deprecated: optionalMember(header, "deprecated", boolean),
				description: optionalMember(header, "description", string),
				explode: optionalMember(header, "explode", boolean),
				required: optionalMember(header, "required", boolean),
				schema: optionalMember(header, "schema", anything),
				style: optionalMember(header, "style", refine(string, isStyleName, "a style name")),
				"x-sensitive": optionalMember(header, "x-sensitive", anything)
			},
			anything
		),
		(read) => ({
			allowEmptyValue: Option.getOrUndefined(read.allowEmptyValue),
			allowReserved: Option.getOrUndefined(read.allowReserved),
			content: Option.getOrUndefined(read.content),
			deprecated: Option.getOrUndefined(read.deprecated),
			description: Option.getOrUndefined(read.description),
			explode: Option.getOrUndefined(read.explode),
			required: Option.getOrUndefined(read.required),
			schema: Option.getOrUndefined(read.schema),
			sensitive: Option.exists(read["x-sensitive"], (mark) => mark === true),
			style: Option.getOrUndefined(read.style)
		})
	)

const readHeader: Reader<HeaderNode> = (value) => Result.flatMap(members(value), headerFields)

const readParameter: Reader<ParameterNode> = (value) =>
	Result.flatMap(members(value), (parameter) =>
		Result.map(
			Result.all({
				fields: headerFields(parameter),
				in: member(parameter, "in", refine(string, isLocation, "a parameter location")),
				name: member(parameter, "name", string)
			}),
			({ fields, ...named }): ParameterNode => ({ ...fields, ...named })
		)
	)

/**
 * The node at `key` as `reader` reads it: none where the document set holds no node there, or one
 * `reader` refuses.
 */
const readAt = <A>(
	resolution: Resolution,
	key: CanonicalKey,
	reader: Reader<A>
): Option.Option<A> =>
	Option.flatMap(nodeOption(resolution, key), (node) => Result.getSuccess(reader(node)))

const rules: Readonly<Record<SpecLine, string>> = {
	"3.0": "oas-3.0",
	"3.1": "oas-3.1",
	"3.2": "oas-3.2"
}

const ignoredHeaders: ReadonlySet<string> = new Set(["accept", "authorization", "content-type"])

/**
 * One row per legal (location, style, explode, allowReserved) of design 6.1; deepObject and the
 * cookie rows are decided by `deepObjectRow` and `decideCookie`.
 */
const styleTable: readonly (readonly [string, StyleName, boolean, boolean, RowId])[] = [
	["path", "matrix", false, false, "STY-01"],
	["path", "matrix", true, false, "STY-02"],
	["path", "label", false, false, "STY-03"],
	["path", "label", true, false, "STY-04"],
	["path", "simple", false, false, "STY-05"],
	["path", "simple", true, false, "STY-06"],
	["path", "matrix", false, true, "STY-07"],
	["path", "matrix", true, true, "STY-08"],
	["path", "label", false, true, "STY-09"],
	["path", "label", true, true, "STY-10"],
	["path", "simple", false, true, "STY-11"],
	["path", "simple", true, true, "STY-12"],
	["query", "form", true, false, "STY-13"],
	["query", "form", false, false, "STY-14"],
	["query", "form", true, true, "STY-15"],
	["query", "form", false, true, "STY-16"],
	["query", "spaceDelimited", false, false, "STY-17"],
	["query", "spaceDelimited", true, false, "STY-18"],
	["query", "spaceDelimited", false, true, "STY-19"],
	["query", "spaceDelimited", true, true, "STY-20"],
	["query", "pipeDelimited", false, false, "STY-21"],
	["query", "pipeDelimited", true, false, "STY-22"],
	["query", "pipeDelimited", false, true, "STY-23"],
	["query", "pipeDelimited", true, true, "STY-24"],
	["header", "simple", false, false, "STY-31"],
	["header", "simple", true, false, "STY-32"]
]

/**
 * The style table's row by its `[location, style, explode, allowReserved]` key; a lookup builds a
 * fresh key, compared structurally.
 */
const rowOf = HashMap.fromIterable<
	readonly [location: string, style: string, explode: boolean, allowReserved: boolean],
	RowId
>(
	Arr.map(styleTable, ([location, style, explode, allowReserved, row]) => [
		[location, style, explode, allowReserved],
		row
	])
)

/**
 * The rows whose style table says no value type fits (design 6.1; inventory "refused").
 */
const explodeNotApplicable: ReadonlySet<RowId> = new Set(["STY-18", "STY-20", "STY-22", "STY-24"])

const cookieStyles: Readonly<Record<SpecLine, readonly StyleName[]>> = {
	"3.0": ["form"],
	"3.1": ["form"],
	"3.2": ["cookie", "form"]
}

const fixedStyles: Readonly<Record<Exclude<Location, "cookie">, readonly StyleName[]>> = {
	header: ["simple"],
	path: ["label", "matrix", "simple"],
	query: ["deepObject", "form", "pipeDelimited", "spaceDelimited"],
	querystring: []
}

const stylesOf = (location: Location, line: SpecLine): readonly StyleName[] =>
	location === "cookie" ? cookieStyles[line] : fixedStyles[location]

const defaultStyle = (location: Location): StyleName =>
	location === "path" || location === "header" ? "simple" : "form"

/**
 * One diagnostic a parameter rule produces, before it is placed at a site. Form Encoding entries
 * reuse the style table's refusals through `formStyleRefusal` (design 6.3).
 */
export interface Finding {
	readonly anchor: string
	readonly code: string
	readonly element: string
	readonly hint?: string
	readonly message: string
	readonly severity: "notice" | "refusal"
}

/**
 * A refusal that tells the author what to do instead.
 */
const refusal = (
	code: string,
	anchor: string,
	element: string,
	message: string,
	hint: string
): Finding => ({ anchor, code, element, hint, message, severity: "refusal" })

/**
 * A refusal whose message is the whole story.
 */
const plainRefusal = (code: string, anchor: string, element: string, message: string): Finding => ({
	anchor,
	code,
	element,
	message,
	severity: "refusal"
})

const notice = (code: string, anchor: string, element: string, message: string): Finding => ({
	anchor,
	code,
	element,
	message,
	severity: "notice"
})

const cookieNames = {
	"STY-33": "Parameter in cookie, style form",
	"STY-34": "Parameter in cookie, style form, explode false",
	"STY-35": "Parameter in cookie, style form, explode false",
	"STY-36": "Parameter in cookie, style form, allowReserved true",
	"STY-37": "Parameter in cookie, style form, explode false, allowReserved true",
	"STY-38": "Parameter in cookie, style cookie",
	"STY-39": "Parameter in cookie, style cookie, explode false"
} as const

const permanentCookieRow = (style: StyleName, allowReserved: boolean) => {
	if (style === "cookie") {
		return "STY-39"
	}

	return allowReserved ? "STY-37" : "STY-35"
}

const stagedCookieRow = (style: StyleName, explode: boolean, allowReserved: boolean) => {
	if (!explode) {
		return "STY-34"
	}

	if (style === "cookie") {
		return "STY-38"
	}

	return allowReserved ? "STY-36" : "STY-33"
}

const deepObjectRow = (line: SpecLine, explode: boolean, allowReserved: boolean): RowId => {
	if (line === "3.2") {
		return allowReserved ? "STY-30" : "STY-27"
	}

	if (allowReserved) {
		return explode ? "STY-28" : "STY-29"
	}

	return explode ? "STY-25" : "STY-26"
}

interface StylePlan {
	readonly allowReserved: boolean
	readonly explode: boolean
	readonly kind: "style"
	readonly nonStandard?: "deepObjectBrackets"
	readonly nonStandardScalars?: "deepObjectScalars"
	readonly row: RowId
	readonly style: StyleName
}

interface ContentPlan {
	readonly kind: "content"
	readonly mediaType: MediaType
	readonly rows: readonly RowId[]
	readonly schemaKey: string
}

/**
 * A parameter or part header the serialization rules can send: its plan, with the notices it
 * carries. Where they cannot, they answer the refusal's finding.
 */
interface Built {
	readonly findings: readonly Finding[]
	readonly plan: ContentPlan | StylePlan
}

/**
 * A parameter the rules build: its plan and notices, under its name, which the name rules prove a
 * `WireName`.
 */
interface Named extends Built {
	readonly wireName: WireName
}

/**
 * What the rules make of one parameter: built under its name, ignored with its notices, or refused.
 */
type Decision = Data.TaggedEnum<{
	Build: Named
	Ignore: { readonly findings: readonly Finding[] }
	Refuse: { readonly finding: Finding }
}>

const Decision = Data.taggedEnum<Decision>()

/**
 * A decision the name rules reach before any serialization rule runs.
 */
type NameDecision = Exclude<Decision, { readonly _tag: "Build" }>

const cookieExplodeFalse = (style: StyleName, allowReserved: boolean): Finding => {
	const row = permanentCookieRow(style, allowReserved)

	return refusal(
		`${row}/cookie-explode-false`,
		"style-values",
		cookieNames[row],
		"A cookie parameter cannot have explode false in 3.2.",
		"refused (permanent): explode: false is invalid with in: cookie"
	)
}

const cookieFormMultiple = refusal(
	"PRM-34/cookie-form-multiple",
	"appendix-d-serializing-headers-and-cookies",
	"Parameter in cookie, style form, array or object",
	"A form cookie cannot carry an array or object, exploded or not; the specification calls it always incorrect.",
	"Use a primitive schema, or style: cookie in 3.2"
)

/**
 * STY-33, 34, 36 and 38 build; STY-35, 37 and 39 are refused for good, and so is any form cookie
 * over an array or object, whatever explode is (PRM-34, Appendix D). A 3.2 explode false form
 * cookie reports its STY row alone.
 */
const decideCookie = (
	line: SpecLine,
	plan: Omit<StylePlan, "kind" | "row">,
	multiple: boolean,
	findings: readonly Finding[]
): Result.Result<Built, Finding> => {
	const { allowReserved, explode, style } = plan
	if (!explode && line === "3.2") {
		return Result.fail(cookieExplodeFalse(style, allowReserved))
	}

	if (style === "form" && multiple) {
		return Result.fail(cookieFormMultiple)
	}

	return Result.succeed({
		findings,
		plan: { ...plan, kind: "style", row: stagedCookieRow(style, explode, allowReserved) }
	})
}

/**
 * In the entry document, official-schema validation (VAL-02 to VAL-04) refuses a style its
 * location does not define before this runs; a parameter in another document-set member, which is
 * not schema-validated, reaches this refusal.
 */
const styleLocation = refusal(
	"STY-40/style-location",
	"style-values",
	"Parameter style",
	"The style is not defined for the parameter's location in this OpenAPI line.",
	"Use a style that the parameter's location defines"
)

const allowEmptyValueIgnored = notice(
	"PRM-08/allow-empty-value-ignored",
	"parameter-allow-empty-value",
	"Parameter allowEmptyValue",
	"allowEmptyValue applies only to a query parameter with a style, so it is ignored here."
)

/**
 * What a 3.0 header notice says: `PRM-32` for a header parameter, `HDR-15` for a schema-serialized
 * response header (design D-OC9).
 */
export const headerPercentEncoding =
	"The 3.0 text implies percent-encoding of header values; 3.1 calls that a mistake, so none is applied."

const headerEncoding = notice(
	"PRM-32/header-percent-encoding",
	"appendix-d-serializing-headers-and-cookies",
	"Header parameter percent-encoding",
	headerPercentEncoding
)

const allowReservedIgnored = notice(
	"PRM-35/allow-reserved-ignored",
	"parameter-allow-reserved",
	"Parameter allowReserved",
	"allowReserved does not apply to this parameter in this OpenAPI line, so it is ignored."
)

/**
 * The STY-26 notice text for a 3.0 or 3.1 `deepObject` whose `explode` is false or omitted; form
 * Encoding rules share it (ENC-12).
 */
export const deepObjectExplodeText =
	"The 3.2 text says explode has no effect for deepObject; it is applied to this line, so the value is exploded."

const deepObjectExplode = (row: RowId): Finding =>
	notice(
		`${row}/explode-no-effect`,
		"parameter-explode",
		"Parameter deepObject explode",
		deepObjectExplodeText
	)

const compoundNested = refusal(
	"PRM-27/compound-nested",
	"style-values",
	"Parameter style deepObject",
	"deepObject is defined only for an object with scalar members; this schema is an array or has an object or array member.",
	"Flatten the parameter, or set nonStandard.deepObjectBrackets in the author config to send the bracket convention"
)

/**
 * PRM-27 (style-values): deepObject is defined only for an object; a schema that also admits a
 * value that is not an object would generate a flag the runtime refuses for every value.
 */
const nonObjectSchema = refusal(
	"PRM-27/non-object-schema",
	"style-values",
	"Parameter style deepObject",
	"deepObject is defined only for an object; this schema also admits a value that is not an object.",
	"Give the parameter an object schema, or use style: form"
)

/**
 * The code of the bracket switch's notice (design 6.1 Bracket switch), on parameters and bodies.
 */
export const bracketChoiceCode = "PRM-27/bracket-author-choice"

/**
 * The code of the scalar switch's notice (design 6.1 Scalar switch), on parameters and bodies.
 */
export const scalarChoiceCode = "PRM-27/scalar-author-choice"

/**
 * The notices of the author config's deepObject switches, which go with an element that is not
 * sent (design 8.5 rule 7).
 */
export const authorChoiceCodes: ReadonlySet<string> = new Set([bracketChoiceCode, scalarChoiceCode])

const bracketAuthorChoice = notice(
	bracketChoiceCode,
	"style-values",
	"Parameter style deepObject",
	"The author config's nonStandard.deepObjectBrackets sends this nested deepObject value in the bracket convention, which the specification does not define."
)

const scalarAuthorChoice = notice(
	scalarChoiceCode,
	"style-values",
	"Parameter style deepObject",
	"The author config's nonStandard.deepObjectScalars sends a scalar value of this deepObject parameter as name=value, which the specification does not define."
)

const cookieName = refusal(
	"PRM-02/invalid-cookie-name",
	"parameter-name",
	"Parameter in cookie name",
	"The cookie parameter name is not an RFC 6265 token.",
	"Use a name made of RFC 9110 token characters"
)

/**
 * In the entry document, official-schema validation (VAL-04) refuses these fields on a querystring
 * parameter before this runs; a parameter in another document-set member, which is not
 * schema-validated, reaches this refusal.
 */
const querystringSchemaFields = refusal(
	"STY-45/querystring-schema-fields",
	"fixed-fields-for-use-with-schema",
	"Parameter in querystring with schema fields",
	"A querystring parameter cannot use schema, style, explode or allowReserved.",
	"Describe the query string with exactly one content entry"
)

/**
 * The rows a content-based parameter's serialization rests on, by location.
 */
const contentRows = (location: Location): readonly RowId[] => {
	if (location === "querystring") {
		return ["STY-42", "STY-43"]
	}

	return location === "header" || location === "cookie" ? ["PRM-24"] : ["PRM-23"]
}

/**
 * The style table defines spaceDelimited and pipeDelimited for an array or object only.
 */
const delimitedStyles: ReadonlySet<StyleName> = new Set(["pipeDelimited", "spaceDelimited"])

const primitiveNotApplicableFinding = (row: RowId): Finding =>
	refusal(
		`${row}/primitive-not-applicable`,
		"style-values",
		"Parameter style spaceDelimited or pipeDelimited over a primitive",
		"The style table defines this style only for an array or object; this schema is a primitive.",
		"Use an array or object schema, or style: form"
	)

const explodeNotApplicableFinding = (row: RowId): Finding =>
	plainRefusal(
		`${row}/explode-not-applicable`,
		"style-values",
		"Parameter style with explode true",
		"The style table defines no value type for this style with explode true."
	)

const decideContent = (node: ParameterNode, content: Content): Result.Result<Built, Finding> => {
	const { mediaType, schemaKey } = content
	if (!isMediaType(mediaType)) {
		return Result.fail(
			plainRefusal(
				"PRM-15/invalid-media-type",
				"parameter-content",
				"Parameter content media type",
				"The content key is not a concrete media type."
			)
		)
	}

	if (Option.isNone(schemaKey)) {
		return Result.fail(
			plainRefusal(
				"PRM-15/missing-schema",
				"parameter-content",
				"Parameter content media type",
				"The content entry has no schema, so the value has no type."
			)
		)
	}

	return Result.succeed({
		findings: node.allowEmptyValue === true ? [allowEmptyValueIgnored] : [],
		plan: {
			kind: "content",
			mediaType,
			rows: contentRows(node.in),
			schemaKey: schemaKey.value
		}
	})
}

/**
 * Whether the line's text gives allowReserved a meaning for this location and style.
 */
const honorsAllowReserved = (node: ParameterNode, style: StyleName, line: SpecLine): boolean => {
	if (node.in === "query") {
		return true
	}

	return line === "3.2" && (node.in === "path" || (node.in === "cookie" && style === "form"))
}

const styleNotices = (
	node: ParameterNode,
	line: SpecLine,
	honored: boolean,
	deepRow: Option.Option<RowId>
): readonly Finding[] => {
	const findings: Finding[] = []
	if (node.allowEmptyValue === true && node.in !== "query") {
		findings.push(allowEmptyValueIgnored)
	}

	if (line === "3.0" && node.in === "header") {
		findings.push(headerEncoding)
	}

	if (node.allowReserved === true && !honored) {
		findings.push(allowReservedIgnored)
	}

	if (Option.isSome(deepRow) && line !== "3.2" && node.explode !== true) {
		findings.push(deepObjectExplode(deepRow.value))
	}

	return findings
}

/**
 * What the author config's scalar switch makes of a `deepObject` schema (design 6.1 Scalar
 * switch). `strict`: the switch is off, or the schema has no scalar branch or has a branch no
 * switch covers (`null`, untyped, unresolved), so the strict rules decide (`PRM-27/non-object-
 * schema` when it admits a non-object). `uncovered`: a nested branch the bracket switch is off for,
 * or a member union neither switch defines (`PRM-27/compound-nested`). `scalars`: every branch is
 * covered and a scalar one by the scalar switch; `scalarsAndNested` when the bracket switch also
 * covers a nested one.
 */
export type ScalarCover = "scalars" | "scalarsAndNested" | "strict" | "uncovered"

/**
 * What the schema shape and the author config add to a parameter's decision: `multiple` for a
 * cookie over an array or object (PRM-34), `nested` for a `deepObject` value beyond one level
 * (PRM-27), `nonObject` for a `deepObject` schema that admits a value that is not an object
 * (PRM-27), `primitive` for a schema that declares only primitive types (STY-17, STY-21),
 * `brackets` for the author config's bracket switch and `scalars` for what its scalar switch makes
 * of a `deepObject` schema (design 6.1 Scalar switch).
 */
interface Traits {
	readonly brackets: boolean
	readonly multiple: boolean
	readonly nested: boolean
	readonly nonObject: boolean
	readonly primitive: boolean
	readonly scalars: ScalarCover
}

/**
 * The style table's applicability checks (design 6.1): explode true where no value type fits,
 * a delimited style over a primitive, and deepObject over a schema that admits non-objects
 * (PRM-27). Query parameters and form Encoding entries (design 6.3) share them.
 */
const inapplicable = (
	row: RowId,
	style: StyleName,
	traits: Pick<Traits, "nonObject" | "primitive">
): Option.Option<Finding> => {
	if (explodeNotApplicable.has(row)) {
		return Option.some(explodeNotApplicableFinding(row))
	}

	if (delimitedStyles.has(style) && traits.primitive) {
		return Option.some(primitiveNotApplicableFinding(row))
	}

	return style === "deepObject" && traits.nonObject ? Option.some(nonObjectSchema) : Option.none()
}

/**
 * Which deepObject switches send a value, or none when an uncovered nested branch refuses it
 * (PRM-27/compound-nested): under the scalar switch the branch walk decides; otherwise the strict
 * nested test, which the bracket switch marks instead of refusing.
 */
interface Marks {
	readonly nested: boolean
	readonly scalars: boolean
}

const deepObjectMarks = (
	cover: ScalarCover,
	strictNested: boolean,
	brackets: boolean
): Option.Option<Marks> => {
	switch (cover) {
		case "scalars": {
			return Option.some({ nested: false, scalars: true })
		}
		case "scalarsAndNested": {
			return brackets ? Option.some({ nested: true, scalars: true }) : Option.none()
		}
		case "strict": {
			return strictNested && !brackets
				? Option.none()
				: Option.some({ nested: strictNested, scalars: false })
		}
		case "uncovered": {
			return Option.none()
		}
	}
}

const markedPlan = (plan: StylePlan, marks: Marks): StylePlan => {
	const bracketed: StylePlan = marks.nested ? { ...plan, nonStandard: "deepObjectBrackets" } : plan

	return marks.scalars ? { ...bracketed, nonStandardScalars: "deepObjectScalars" } : bracketed
}

const decideStyle = (
	node: ParameterNode,
	line: SpecLine,
	traits: Traits
): Result.Result<Built, Finding> => {
	const location = node.in
	const style = node.style ?? defaultStyle(location)
	const explode = node.explode ?? (style === "form" || style === "cookie")
	if (!Arr.contains(stylesOf(location, line), style)) {
		return Result.fail(styleLocation)
	}

	const honored = honorsAllowReserved(node, style, line)
	const allowReserved = honored && node.allowReserved === true
	if (location === "cookie") {
		const findings = styleNotices(node, line, honored, Option.none())

		return decideCookie(line, { allowReserved, explode, style }, traits.multiple, findings)
	}

	const deepRow =
		style === "deepObject"
			? Option.some(deepObjectRow(line, node.explode === true, allowReserved))
			: Option.none()
	const found = Option.orElse(deepRow, () =>
		HashMap.get(rowOf, [location, style, explode, allowReserved])
	)
	if (Option.isNone(found)) {
		return Result.fail(styleLocation)
	}

	const row = found.value
	/**
	 * PRM-27: a deepObject over a schema that admits non-objects is refused, bracket switch or not,
	 * unless the scalar switch's branch walk decides it (design 6.1 Scalar switch).
	 */
	const cover: ScalarCover = Option.isNone(deepRow) ? "strict" : traits.scalars
	const blocked = inapplicable(
		row,
		style,
		cover === "strict" ? traits : { ...traits, nonObject: false }
	)
	if (Option.isSome(blocked)) {
		return Result.fail(blocked.value)
	}

	const marks = deepObjectMarks(cover, Option.isSome(deepRow) && traits.nested, traits.brackets)
	if (Option.isNone(marks)) {
		return Result.fail(compoundNested)
	}

	const plan: StylePlan = {
		allowReserved,
		explode: explode || Option.isSome(deepRow),
		kind: "style",
		row,
		style
	}

	return Result.succeed({
		findings: [
			...styleNotices(node, line, honored, deepRow),
			...(marks.value.nested ? [bracketAuthorChoice] : []),
			...(marks.value.scalars ? [scalarAuthorChoice] : [])
		],
		plan: markedPlan(plan, marks.value)
	})
}

/**
 * The name rules (PRM-02, PRM-19, PRM-21): the name, proved a `WireName`, for the serialization
 * rules to go on with, or the decision they reach.
 */
const decideName = (node: ParameterNode): Result.Result<WireName, NameDecision> => {
	const name = Str.toLowerCase(node.name)
	if (node.in === "header" && ignoredHeaders.has(name)) {
		return Result.fail(
			Decision.Ignore({
				findings: [
					notice(
						"PRM-19/ignored-header",
						"parameter-name",
						"Header parameter Accept, Content-Type or Authorization",
						"The specification says this header parameter SHALL be ignored; the generated CLI sets the header itself."
					)
				]
			})
		)
	}

	if (node.in === "header" && name === "cookie") {
		return Result.fail(
			Decision.Refuse({
				finding: refusal(
					"PRM-21/cookie-header",
					"parameter-name",
					"Header parameter Cookie",
					"A header parameter named Cookie has no defined effect.",
					"Describe cookies with a parameter in: cookie"
				)
			})
		)
	}

	const wireName = node.name
	if (!isWireName(wireName)) {
		return Result.fail(
			Decision.Refuse({
				finding: plainRefusal(
					"PRM-02/invalid-name",
					"parameter-name",
					"Parameter name",
					"The parameter name contains control characters or lone surrogates."
				)
			})
		)
	}

	return node.in === "cookie" && !isCookieName(wireName)
		? Result.fail(Decision.Refuse({ finding: cookieName }))
		: Result.succeed(wireName)
}

/**
 * A parameter's one content entry: its media type and the schema key of its media type object.
 * A `querystring` form entry's Encoding Objects are decided by the body form rules (design 6.1), in
 * the operation assembly.
 */
interface Content {
	readonly mediaType: string
	readonly schemaKey: Option.Option<string>
}

type Media = Option.Option<Content>

/**
 * STY-45: a querystring is content only.
 */
const usesSchemaFields = (node: ParameterNode): boolean =>
	node.schema !== undefined ||
	node.style !== undefined ||
	node.explode !== undefined ||
	node.allowReserved !== undefined

/**
 * The serialization rules: a content parameter's by its one entry, any other's by its style.
 */
const serialize = (
	node: ParameterNode,
	line: SpecLine,
	media: Media,
	traits: Traits
): Result.Result<Built, Finding> =>
	Option.match(media, {
		onNone: () => decideStyle(node, line, traits),
		onSome: (content) => decideContent(node, content)
	})

const decide = (node: ParameterNode, line: SpecLine, media: Media, traits: Traits): Decision => {
	const named = decideName(node)
	if (Result.isFailure(named)) {
		return named.failure
	}

	if (node.in === "querystring" && usesSchemaFields(node)) {
		return Decision.Refuse({ finding: querystringSchemaFields })
	}

	return Result.match(serialize(node, line, media, traits), {
		onFailure: (finding) => Decision.Refuse({ finding }),
		onSuccess: (built) => Decision.Build({ ...built, wireName: named.success })
	})
}

/**
 * What the earlier stages guarantee; a violation means one of them let something through.
 */
const contractReason = (
	node: ParameterNode,
	line: SpecLine
): ParameterNotReadable["reason"] | undefined => {
	if (node.in === "querystring" && line !== "3.2") {
		return "line-mismatch"
	}

	/**
	 * A querystring with schema is refused as STY-45, not stopped here.
	 */
	const both = node.schema !== undefined && node.content !== undefined
	if (
		(node.schema === undefined && node.content === undefined) ||
		(both && node.in !== "querystring")
	) {
		return "schema-xor-content"
	}

	if (node.content !== undefined && Record.keys(node.content).length !== 1) {
		return "content-entry-count"
	}

	return node.in === "path" && node.required !== true ? "path-not-required" : undefined
}

/**
 * A content entry's media type object, which 3.2 lets be a reference: its schema key.
 */
const mediaContent = (
	resolution: Resolution,
	mediaType: string,
	mediaSite: CanonicalKey
): Content => {
	const home = follow(resolution, mediaSite)
	const declared = Option.filter(readAt(resolution, home, members), (media) =>
		Record.has(media, "schema")
	)

	return {
		mediaType,
		schemaKey: Option.map(declared, () => schemaKeyAt(resolution, childKey(home, "schema")))
	}
}

interface Related {
	readonly document: string
	readonly pointer: string
}

const toDiagnostics = (
	resolution: Resolution,
	site: ParameterSite,
	related: readonly Related[],
	wireName: string,
	findings: readonly Finding[]
): Effect.Effect<readonly Diagnostic[]> => {
	const wire = stripUnsafeText(wireName)

	return Effect.forEach(findings, (finding) =>
		makeDiagnostic({
			code: finding.code,
			document: resolution.document,
			element: finding.element,
			hint: finding.hint,
			message: finding.message,
			openapi: site.openapi,
			operation: site.operation,
			pointer: site.pointer,
			related: related.length > 0 ? related : undefined,
			scope: "element",
			severity: finding.severity,
			specSection: specSectionUrl(resolution.line, finding.anchor),
			wire: wire === "" ? undefined : wire
		})
	).pipe(Effect.orDie)
}

const sorted = (rows: readonly RowId[]): readonly RowId[] =>
	Arr.sort(Arr.dedupe(rows), Order.String)

interface Source {
	readonly node: ParameterNode
	readonly reference: ResolvedReference | undefined
	readonly related: readonly Related[]
	readonly target: CanonicalKey
}

const read = (
	resolution: Resolution,
	site: ParameterSite
): Result.Result<Source, ParameterNotReadable> => {
	const use = { document: resolution.document, pointer: site.pointer }
	const reference = referenceIn(resolution, use)
	const target = follow(resolution, use)

	return Result.fromOption(
		Option.map(readAt(resolution, target, readParameter), (node) => ({
			node,
			reference,
			related: reference === undefined ? [] : [target],
			target
		})),
		() => new ParameterNotReadable({ pointer: site.pointer, reason: "not-a-parameter" })
	)
}

/**
 * A schema's `type` keyword: one type name or a list of them.
 */
const typeKeyword = union([string, array(string)])

/**
 * The type names a schema's `type` keyword declares; none when it declares no type.
 */
export const typeNames = (type: string | readonly string[] | undefined): readonly string[] =>
	type === undefined ? [] : Arr.ensure(type)

/**
 * The `type` a schema declares, or none; a `type` of another shape makes the schema unreadable.
 */
const declaredType: Reader<Option.Option<string | readonly string[]>> = (value) =>
	Result.flatMap(members(value), (schema) => optionalMember(schema, "type", typeKeyword))

/**
 * The type names the schema at `key` declares, through `$ref`; none when it declares no type or
 * cannot be read.
 */
const typesAt = (resolution: Resolution, key: CanonicalKey): readonly string[] =>
	typeNames(
		Option.getOrUndefined(Option.flatten(readAt(resolution, follow(resolution, key), declaredType)))
	)

/**
 * Whether a list of type names includes `array` or `object`.
 */
export const compound = (types: readonly string[]): boolean =>
	Arr.some(types, (name) => name === "array" || name === "object")

/**
 * Whether a cookie's schema, through `$ref`, declares an array or object type (PRM-34).
 */
const carriesMultiple = (resolution: Resolution, source: Source): boolean =>
	source.node.in === "cookie" &&
	source.node.schema !== undefined &&
	compound(typesAt(resolution, childKey(source.target, "schema")))

/**
 * The `properties` and `additionalProperties` an object schema declares, each none where absent;
 * a `properties` that is no object makes the schema unreadable.
 */
const objectMembers = (value: unknown) =>
	Result.flatMap(members(value), (schema) =>
		struct(
			schema,
			{
				additionalProperties: optionalMember(schema, "additionalProperties", anything),
				properties: optionalMember(schema, "properties", members)
			},
			anything
		)
	)

/**
 * The property and additionalProperties member sites of an object schema at `home`, in that order;
 * none where it declares neither or cannot be read.
 */
const memberSites = (resolution: Resolution, home: CanonicalKey): readonly CanonicalKey[] =>
	Option.match(readAt(resolution, home, objectMembers), {
		onNone: () => [],
		onSome: ({ additionalProperties, properties }) => [
			...Arr.flatMap(Option.toArray(properties), (declared) =>
				Arr.map(Record.keys(declared), (name) => childKey(home, "properties", name))
			),
			...Arr.map(Option.toArray(additionalProperties), () => childKey(home, "additionalProperties"))
		]
	})

/**
 * Whether a deepObject query parameter's schema, through `$ref`, is an array or declares a
 * property or `additionalProperties` schema of an object or array type (PRM-27). An untyped
 * member is not nested.
 */
const nestsDeeply = (resolution: Resolution, source: Source): boolean => {
	const { node, target } = source
	if (node.in !== "query" || node.style !== "deepObject" || node.schema === undefined) {
		return false
	}

	const home = follow(resolution, childKey(target, "schema"))

	return (
		Arr.contains(typesAt(resolution, home), "array") ||
		Arr.some(memberSites(resolution, home), (site) => compound(typesAt(resolution, site)))
	)
}

/**
 * The `anyOf` and `oneOf` subschemas and the `properties` a schema declares, each none where absent;
 * an `anyOf` or `oneOf` that is no array makes the schema unreadable.
 */
const composition = (value: unknown) =>
	Result.flatMap(members(value), (schema) =>
		struct(
			schema,
			{
				anyOf: optionalMember(schema, "anyOf", array(anything)),
				oneOf: optionalMember(schema, "oneOf", array(anything)),
				properties: optionalMember(schema, "properties", anything)
			},
			anything
		)
	)

/**
 * The sites of an applicator's subschemas at `home`, by index; none where it is absent.
 */
const subschemaSites = (
	home: CanonicalKey,
	keyword: string,
	subschemas: Option.Option<readonly unknown[]>
): readonly CanonicalKey[] =>
	Arr.flatMap(Option.toArray(subschemas), (declared) =>
		Arr.map(declared, (_, index) => childKey(home, keyword, String(index)))
	)

/**
 * The sites of a schema's `anyOf` subschemas, then of its `oneOf` ones.
 */
const unionSites = (
	home: CanonicalKey,
	declared: {
		readonly anyOf: Option.Option<readonly unknown[]>
		readonly oneOf: Option.Option<readonly unknown[]>
	}
): readonly CanonicalKey[] => [
	...subschemaSites(home, "anyOf", declared.anyOf),
	...subschemaSites(home, "oneOf", declared.oneOf)
]

/**
 * One `objectOnly` walk: each resolved schema is decided once (`memo`), and a schema already on the
 * current path is a cycle, so the walk ends. `arrays` says whether an array counts with the objects,
 * as it does for PRM-27, whose nested test refuses it.
 */
interface ObjectWalk {
	readonly arrays: boolean
	readonly memo: Map<string, boolean>
	readonly path: Set<string>
}

const walkOf = (arrays: boolean): ObjectWalk => ({ arrays, memo: new Map(), path: new Set() })

/**
 * What one resolved schema says on its own about admitting only objects (and arrays, when the walk
 * counts them): a declared type list must name nothing else; an untyped schema is an object when it
 * declares `properties`, except that its anyOf and oneOf members, when it has any, decide with it.
 */
interface OwnVerdict {
	readonly members: readonly CanonicalKey[]
	readonly only: boolean
}

const ownVerdict = (resolution: Resolution, home: CanonicalKey, walk: ObjectWalk): OwnVerdict => {
	const types = typesAt(resolution, home)
	if (types.length > 0) {
		const counted = (name: string) => name === "object" || (walk.arrays && name === "array")

		return { members: [], only: Arr.every(types, counted) }
	}

	return Option.match(readAt(resolution, home, composition), {
		onNone: () => ({ members: [], only: false }),
		onSome: (declared) => {
			const alternatives = unionSites(home, declared)

			return {
				members: alternatives,
				only: alternatives.length > 0 || Option.isSome(declared.properties)
			}
		}
	})
}

/**
 * Whether the schema at `key`, through `$ref`, admits only objects: its own verdict, or every
 * anyOf and oneOf member's. A cycle fails closed (not object-only); a result reached through one
 * is false, so memoizing it is sound.
 */
const objectOnly = (resolution: Resolution, key: CanonicalKey, walk: ObjectWalk): boolean => {
	const home = follow(resolution, key)
	const id = keyOf(home)
	const known = walk.memo.get(id)
	if (known !== undefined) {
		return known
	}

	if (walk.path.has(id)) {
		return false
	}

	walk.path.add(id)

	const verdict = ownVerdict(resolution, home, walk)
	const only =
		verdict.only && Arr.every(verdict.members, (site) => objectOnly(resolution, site, walk))

	walk.path.delete(id)
	walk.memo.set(id, only)

	return only
}

/**
 * The value traits of one schema site, through `$ref`, that the style table's applicability checks
 * read (`inapplicable`): `primitive` when it declares types and none of them is an array or object
 * (an untyped schema is not primitive), and, for a `deepObject` value only, `nonObject` when it
 * admits a value that is not an object (PRM-27). No schema has neither trait. Parameters and form
 * Encoding entries share it.
 */
const valueTraits = (
	resolution: Resolution,
	schema: CanonicalKey | undefined,
	deepObject: boolean
): Pick<Traits, "nonObject" | "primitive"> => {
	if (schema === undefined) {
		return { nonObject: false, primitive: false }
	}

	const types = typesAt(resolution, schema)
	const objects = deepObject ? objectOnly(resolution, schema, walkOf(true)) : true

	return { nonObject: !objects, primitive: types.length > 0 && !compound(types) }
}

/**
 * A parameter's own schema site, or `undefined` for a `content` parameter.
 */
const schemaOf = (source: Source): CanonicalKey | undefined =>
	source.node.schema === undefined ? undefined : childKey(source.target, "schema")

/**
 * Whether a styled parameter's value is an object (design 6.1): its schema, through `$ref`, admits
 * only objects, by `type: object`, by `properties` with no type, or by anyOf and oneOf members that
 * all do. Emit reads it to take the value as JSON.
 */
const objectValued = (resolution: Resolution, source: Source): boolean =>
	source.node.schema !== undefined &&
	objectOnly(resolution, childKey(source.target, "schema"), walkOf(false))

/**
 * One branch of a `deepObject` schema (design 6.1 Scalar switch): an object with scalar members
 * (`flat`, the standard rule), an object with nested members or an array (`nested`, the bracket
 * switch's), a scalar (`scalar`, the scalar switch's), an object with a member whose union mixes
 * objects with other values (`mixed`, which neither switch defines), or anything else (`other`:
 * `null`, untyped, unresolved, or a cycle).
 */
type Branch = "flat" | "mixed" | "nested" | "other" | "scalar"

/**
 * One branch walk: each resolved schema is classified once (`memo`), and a schema already on the
 * current path is a cycle, so the walk ends.
 */
interface BranchWalk {
	readonly memo: Map<string, ReadonlySet<Branch>>
	readonly path: Set<string>
}

/**
 * The keywords one schema declares that the branch walk reads, each none where absent: an `anyOf`,
 * `oneOf` or `enum` that is no array, or a `type` of another shape, makes the schema unreadable.
 */
const branchKeywords = (value: unknown) =>
	Result.flatMap(members(value), (schema) =>
		struct(
			schema,
			{
				anyOf: optionalMember(schema, "anyOf", array(anything)),
				const: optionalMember(schema, "const", anything),
				enum: optionalMember(schema, "enum", array(anything)),
				nullable: optionalMember(schema, "nullable", anything),
				oneOf: optionalMember(schema, "oneOf", array(anything)),
				properties: optionalMember(schema, "properties", anything),
				type: optionalMember(schema, "type", typeKeyword)
			},
			anything
		)
	)

/**
 * The `enum` or `const` values of a scalar branch: at least one, each a string, a finite number or
 * a boolean.
 */
const scalarValues = check(
	array(union([string, check(number, Number.isFinite, "a finite number"), boolean])),
	Arr.isReadonlyArrayNonEmpty,
	"at least one value"
)

const scalarTypes: ReadonlySet<string> = new Set(["boolean", "integer", "number", "string"])

/**
 * What one resolved schema declares on its own, before any member is walked: the branches it
 * settles (`kinds`), the anyOf and oneOf members whose branches it is the union of (`union`), and
 * the members of its object branch (`object`), when it has one.
 */
interface OwnBranches {
	readonly kinds: readonly Branch[]
	readonly object?: readonly CanonicalKey[]
	readonly union: readonly CanonicalKey[]
}

const settled = (kinds: readonly Branch[]): OwnBranches => ({ kinds, union: [] })

/**
 * The branches of a `type` list, the object branch's members read once for `object`.
 */
const typedBranches = (
	resolution: Resolution,
	home: CanonicalKey,
	declared: {
		readonly properties: Option.Option<unknown>
		readonly type: Option.Option<string | readonly string[]>
	}
): OwnBranches => {
	const types = typeNames(Option.getOrUndefined(declared.type))
	const kinds: Branch[] = []
	if (types.length === 0 && Option.isNone(declared.properties)) {
		return settled(["other"])
	}

	for (const name of types) {
		if (name === "array") {
			kinds.push("nested")
		} else if (name !== "object") {
			kinds.push(scalarTypes.has(name) ? "scalar" : "other")
		}
	}

	const objects = types.length === 0 || Arr.contains(types, "object")

	return objects ? { kinds, object: memberSites(resolution, home), union: [] } : settled(kinds)
}

/**
 * One resolved schema's own branches: an anyOf or oneOf beside no constraint of its own is the union
 * of its members' branches (beside `type`, `enum`, `const` or `properties` it fails closed); an
 * `enum` or `const` of strings, numbers and booleans is a scalar branch; then the `type` list, or
 * an untyped schema with `properties` (an object).
 */
const ownBranches = (resolution: Resolution, home: CanonicalKey): OwnBranches => {
	const keywords = readAt(resolution, home, branchKeywords)
	if (Option.isNone(keywords)) {
		return settled(["other"])
	}

	const declared = keywords.value
	if (
		resolution.line === "3.0" &&
		Option.exists(declared.nullable, (nullable) => nullable === true)
	) {
		return settled(["other"])
	}

	const alternatives = unionSites(home, declared)
	if (alternatives.length > 0) {
		const constrained =
			Option.isSome(declared.type) ||
			Option.isSome(declared.enum) ||
			Option.isSome(declared.const) ||
			Option.isSome(declared.properties)

		return constrained ? settled(["other"]) : { kinds: [], union: alternatives }
	}

	const values = Option.orElse(
		Option.map(declared.const, (constant): readonly unknown[] => [constant]),
		() => declared.enum
	)
	if (Option.isSome(values)) {
		return settled([Result.isSuccess(scalarValues(values.value)) ? "scalar" : "other"])
	}

	return typedBranches(resolution, home, declared)
}

/**
 * How a member of an object branch nests: its declared type is an object or array (`nested`, as
 * the strict nested test reads it), it is an anyOf or oneOf union (`union`, walked), or neither
 * (`flat`: an untyped member is scalar, as it is today).
 */
const memberNesting = (resolution: Resolution, site: CanonicalKey): "flat" | "nested" | "union" => {
	if (compound(typesAt(resolution, site))) {
		return "nested"
	}

	const composed = Option.exists(
		readAt(resolution, follow(resolution, site), composition),
		(declared) => Option.isSome(declared.anyOf) || Option.isSome(declared.oneOf)
	)

	return composed ? "union" : "flat"
}

/**
 * A member union holding objects nests (`nested`); objects beside other values is `mixed`; a
 * union with no object is a scalar member (`flat`).
 */
const unionMember = (kinds: ReadonlySet<Branch>): Branch => {
	const objects = kinds.has("flat") || kinds.has("mixed") || kinds.has("nested")
	if (kinds.has("mixed") || (objects && (kinds.has("scalar") || kinds.has("other")))) {
		return "mixed"
	}

	return objects ? "nested" : "flat"
}

/**
 * An object branch from its members' kinds: `mixed` over `nested` over `flat`.
 */
const objectBranch = (nestings: readonly Branch[]): Branch => {
	if (Arr.contains(nestings, "mixed")) {
		return "mixed"
	}

	return Arr.contains(nestings, "nested") ? "nested" : "flat"
}

/**
 * The branches the schema at `key` admits, through `$ref`. A cycle is `other`, which refuses the
 * entry, so memoizing a result reached through one is sound.
 */
const branchesOf = (
	resolution: Resolution,
	key: CanonicalKey,
	walk: BranchWalk
): ReadonlySet<Branch> => {
	const home = follow(resolution, key)
	const id = keyOf(home)
	const known = walk.memo.get(id)
	if (known !== undefined) {
		return known
	}

	if (walk.path.has(id)) {
		return new Set<Branch>(["other"])
	}

	walk.path.add(id)

	const own = ownBranches(resolution, home)
	const kinds = new Set<Branch>(own.kinds)
	for (const site of own.union) {
		for (const kind of branchesOf(resolution, site, walk)) {
			kinds.add(kind)
		}
	}

	if (own.object !== undefined) {
		const nestings = Arr.map(own.object, (site): Branch => {
			const nesting = memberNesting(resolution, site)

			return nesting === "union" ? unionMember(branchesOf(resolution, site, walk)) : nesting
		})

		kinds.add(objectBranch(nestings))
	}

	walk.path.delete(id)
	walk.memo.set(id, kinds)

	return kinds
}

/**
 * Classifies the `deepObject` schema at `schema` branch by branch, through `$ref`, `anyOf`,
 * `oneOf`, a `type` list, `enum` and `const`, memoized, and decides it under the author config's
 * `switches`. Query parameters and form Encoding entries share it (design 6.1, 6.3).
 */
export const scalarCover = (
	resolution: Resolution,
	schema: CanonicalKey,
	switches: AuthorConfig["nonStandard"]
): ScalarCover => {
	if (switches?.deepObjectScalars !== true) {
		return "strict"
	}

	const walk: BranchWalk = { memo: new Map(), path: new Set() }
	const kinds = branchesOf(resolution, schema, walk)
	if (!kinds.has("scalar") || kinds.has("other")) {
		return "strict"
	}

	const nested = kinds.has("nested")
	if (kinds.has("mixed") || (nested && switches.deepObjectBrackets !== true)) {
		return "uncovered"
	}

	return nested ? "scalarsAndNested" : "scalars"
}

/**
 * The scalar switch's decision for a deepObject query parameter; `Strict` for any other.
 */
const scalarsOf = (resolution: Resolution, site: ParameterSite, source: Source): ScalarCover => {
	const { node, target } = source
	if (node.in !== "query" || node.style !== "deepObject" || node.schema === undefined) {
		return "strict"
	}

	return scalarCover(resolution, childKey(target, "schema"), site.nonStandard)
}

/**
 * The query style table's refusal for one form-urlencoded Encoding entry (design 6.3: `style`,
 * `explode` and `allowReserved` apply as for query parameters), by the checks query parameters use:
 * STY-18/20/22/24 explode not applicable, STY-17/21 a delimited style over a primitive, and PRM-27
 * a deepObject over a schema that admits non-objects. `given` holds the entry's explicit fields;
 * the query defaults fill the rest. `schema` is the property's schema site, through `$ref`. `None`
 * means the table does not refuse the entry, or its style is outside the query table and is not
 * decided here.
 */
export const formStyleRefusal = (
	resolution: Resolution,
	schema: CanonicalKey | undefined,
	given: {
		readonly allowReserved?: boolean
		readonly explode?: boolean
		readonly style?: StyleName
	}
): Option.Option<Finding> => {
	const style = given.style ?? "form"
	const allowReserved = given.allowReserved === true
	const found =
		style === "deepObject"
			? Option.some(deepObjectRow(resolution.line, given.explode === true, allowReserved))
			: HashMap.get(rowOf, ["query", style, given.explode ?? style === "form", allowReserved])
	if (Option.isNone(found)) {
		return Option.none()
	}

	return inapplicable(found.value, style, valueTraits(resolution, schema, style === "deepObject"))
}

const mediaOf = (resolution: Resolution, source: Source): Media =>
	Option.map(Arr.head(Record.keys(source.node.content ?? {})), (mediaType) =>
		mediaContent(resolution, mediaType, childKey(source.target, "content", mediaType))
	)

const serializationOf = (
	node: ParameterNode,
	plan: ContentPlan | StylePlan,
	line: SpecLine,
	origin: Related,
	objectValue: boolean
) => {
	if (plan.kind === "content") {
		return {
			encoding: [],
			kind: plan.kind,
			mediaType: plan.mediaType,
			origin,
			rows: sorted(["PRM-15", ...plan.rows]),
			rules: rules[line],
			schema: { key: plan.schemaKey }
		}
	}

	const honored = node.in === "query" && node.allowEmptyValue === true

	const serialization = {
		allowReserved: plan.allowReserved,
		explode: plan.explode,
		kind: plan.kind,
		objectValued: objectValue,
		origin,
		rows: sorted(honored ? [plan.row, "PRM-08"] : [plan.row]),
		rules: rules[line],
		style: plan.style
	}

	const bracketed =
		plan.nonStandard === undefined
			? serialization
			: { ...serialization, nonStandard: plan.nonStandard }

	return plan.nonStandardScalars === undefined
		? bracketed
		: { ...bracketed, nonStandardScalars: plan.nonStandardScalars }
}

const parameterRows = (node: ParameterNode, plan: ContentPlan | StylePlan): readonly RowId[] => {
	if (plan.kind === "content") {
		return ["PRM-01", "PRM-15"]
	}

	return node.in === "query" && node.allowEmptyValue === true ? ["PRM-01", "PRM-08"] : ["PRM-01"]
}

/**
 * The schema key a plan types its value by: a content entry's, or the parameter's own schema's.
 */
const planSchemaKey = (
	resolution: Resolution,
	target: CanonicalKey,
	plan: ContentPlan | StylePlan
): string =>
	plan.kind === "content" ? plan.schemaKey : schemaKeyAt(resolution, childKey(target, "schema"))

const build = Effect.fnUntraced(function* build(
	resolution: Resolution,
	site: ParameterSite,
	source: Source,
	named: Named,
	mark: SensitiveMark
) {
	const { node, reference, target } = source
	const { plan, wireName } = named
	const origin = { document: resolution.document, pointer: site.pointer }
	const objectValue = plan.kind === "style" && objectValued(resolution, source)

	return yield* Schema.decodeEffect(Parameter)({
		deprecated: node.deprecated ?? false,
		docs: docsOf(reference?.description ?? node.description, reference?.summary),
		location: node.in,
		origin,
		required: node.required ?? false,
		rows: sorted(parameterRows(node, plan)),
		schema: { key: planSchemaKey(resolution, target, plan) },
		...mark,
		serialization: serializationOf(node, plan, resolution.line, origin, objectValue),
		wireName
	}).pipe(Effect.orDie)
})

/**
 * The schema sites a parameter carries: its `schema`, or its one content entry's `schema`.
 */
const schemaSitesOf = (resolution: Resolution, source: Source): readonly CanonicalKey[] => {
	const { node, target } = source
	if (node.schema !== undefined) {
		return [childKey(target, "schema")]
	}

	const [mediaType] = Record.keys(node.content ?? {})

	return mediaType === undefined
		? []
		: [childKey(follow(resolution, childKey(target, "content", mediaType)), "schema")]
}

/**
 * The keywords the password reading walks on one schema, each none where absent: an `allOf`,
 * `anyOf` or `oneOf` that is no array makes the schema unreadable; any `x-sensitive` reads.
 */
const markedKeywords = (value: unknown) =>
	Result.flatMap(members(value), (schema) =>
		struct(
			schema,
			{
				allOf: optionalMember(schema, "allOf", array(anything)),
				anyOf: optionalMember(schema, "anyOf", array(anything)),
				oneOf: optionalMember(schema, "oneOf", array(anything)),
				"x-sensitive": optionalMember(schema, "x-sensitive", anything)
			},
			anything
		)
	)

/**
 * Whether the schema at `key` carries `x-sensitive: true` on any node the password reading walks
 * (names `isPassword`): each node of its `$ref` chain with its sibling keywords, each `allOf`
 * member and each `anyOf` or `oneOf` branch. A node already on the walk is not read twice, so a
 * cycle ends. An unreadable node is not marked.
 */
const schemaMarked = (resolution: Resolution, key: CanonicalKey, seen: Set<string>): boolean => {
	const id = keyOf(key)
	if (seen.has(id)) {
		return false
	}

	seen.add(id)

	return Option.exists(
		readAt(resolution, key, markedKeywords),
		(node) =>
			Option.exists(node["x-sensitive"], (mark) => mark === true) ||
			Arr.some(
				[
					follow(resolution, key),
					...subschemaSites(key, "allOf", node.allOf),
					...unionSites(key, node)
				],
				(at) => schemaMarked(resolution, at, seen)
			)
	)
}

interface SensitiveMark {
	readonly sensitive?: true
}

/**
 * The `sensitive` mark of a Parameter or Header Object: present when `x-sensitive: true` sits on
 * the object itself or anywhere `schemaMarked` walks its schema.
 */
const sensitiveOf = (resolution: Resolution, source: Source): SensitiveMark => {
	const seen = new Set<string>()
	const marked =
		source.node.sensitive ||
		Arr.some(schemaSitesOf(resolution, source), (at) => schemaMarked(resolution, at, seen))

	return marked ? { sensitive: true } : {}
}

/**
 * Normalizes one Parameter Object into a `Parameter`, a notice-only ignore, or an element-scope
 * refusal (design 2.2, 6.1, 6.2). Defaults come from the line's text, never from a schema
 * `default`. A site the earlier stages should have stopped fails with `ParameterNotReadable`.
 */
export const normalizeParameter = Effect.fnUntraced(function* normalizeParameter(
	resolution: Resolution,
	site: ParameterSite
): Effect.fn.Return<ParameterOutcome, ParameterNotReadable> {
	const source = yield* Effect.fromResult(read(resolution, site))
	const reason = contractReason(source.node, resolution.line)
	if (reason !== undefined) {
		return yield* new ParameterNotReadable({ pointer: site.pointer, reason })
	}

	const deepObject = source.node.in === "query" && source.node.style === "deepObject"
	const values = valueTraits(resolution, schemaOf(source), deepObject)
	const decision = decide(source.node, resolution.line, mediaOf(resolution, source), {
		brackets: site.nonStandard?.deepObjectBrackets === true,
		multiple: carriesMultiple(resolution, source),
		nested: nestsDeeply(resolution, source),
		nonObject: values.nonObject,
		primitive: values.primitive,
		scalars: scalarsOf(resolution, site, source)
	})
	const diagnostics = (findings: readonly Finding[]) =>
		toDiagnostics(resolution, site, source.related, source.node.name, findings)
	if (Decision.$is("Ignore")(decision)) {
		const ignored = yield* diagnostics(decision.findings)

		return ParameterOutcome.Ignored({ diagnostics: ignored })
	}

	if (Decision.$is("Refuse")(decision)) {
		const refused = yield* diagnostics([decision.finding])

		return ParameterOutcome.Refused({
			diagnostics: refused,
			required: source.node.required ?? false
		})
	}

	if (Arr.some(schemaSitesOf(resolution, source), (at) => appliesDynamicKeyword(resolution, at))) {
		return ParameterOutcome.Refused({ diagnostics: [], required: source.node.required ?? false })
	}

	const implemented = yield* diagnostics(decision.findings)
	const parameter = yield* build(
		resolution,
		site,
		source,
		decision,
		sensitiveOf(resolution, source)
	)

	return ParameterOutcome.Implemented({ diagnostics: implemented, parameter })
})

/**
 * How one encoding part header is typed and sent: as a header parameter of its name would be, or
 * `Unsupported` with the reason the header parameter path cannot carry it.
 */
export type PartHeaderOutcome = Data.TaggedEnum<{
	Typed: {
		readonly schema: { readonly key: string }
		readonly sensitive?: true
		readonly serialization: ReturnType<typeof serializationOf>
	}
	Unsupported: { readonly reason: string }
}>

/**
 * Constructors and dispatch for {@link PartHeaderOutcome}.
 */
export const PartHeaderOutcome = Data.taggedEnum<PartHeaderOutcome>()

const unsupported = (reason: string): PartHeaderOutcome => PartHeaderOutcome.Unsupported({ reason })

/**
 * Decides an encoding part header (ENC-03, HDR-01) by the header parameter rules: the Header
 * Object at use site `site`, read where its `$ref` leads, as `in: header` under `name`. The name
 * rules of header parameters (PRM-19, PRM-21) govern the operation's own headers and do not apply
 * to a part's. A style or content the header parameter path refuses, a dynamic keyword in its
 * schema, or a Header Object with neither or both of `schema` and `content` is `Unsupported`. The
 * notices a header parameter would carry are not repeated here. `origin` is the header's pointer.
 */
export const partHeader = (
	resolution: Resolution,
	site: CanonicalKey,
	name: string,
	origin: Related
): PartHeaderOutcome => {
	const target = follow(resolution, site)
	const decoded = readAt(resolution, target, readHeader)
	if (Option.isNone(decoded)) {
		return unsupported("The header is not a Header Object.")
	}

	const node: ParameterNode = { ...decoded.value, in: "header", name }
	if ((node.schema === undefined) === (node.content === undefined)) {
		return unsupported("The header needs exactly one of schema and content.")
	}

	if (node.content !== undefined && Record.keys(node.content).length !== 1) {
		return unsupported("The header's content needs exactly one media type.")
	}

	const source: Source = { node, reference: referenceIn(resolution, site), related: [], target }
	const built = serialize(node, resolution.line, mediaOf(resolution, source), {
		brackets: false,
		multiple: false,
		nested: nestsDeeply(resolution, source),
		nonObject: false,
		primitive: valueTraits(resolution, schemaOf(source), false).primitive,
		scalars: "strict"
	})
	if (Result.isFailure(built)) {
		return unsupported(built.failure.message)
	}

	if (Arr.some(schemaSitesOf(resolution, source), (at) => appliesDynamicKeyword(resolution, at))) {
		return unsupported("The header's schema applies a dynamic keyword.")
	}

	const { plan } = built.success
	const objectValue = plan.kind === "style" && objectValued(resolution, source)

	return PartHeaderOutcome.Typed({
		schema: { key: planSchemaKey(resolution, target, plan) },
		...sensitiveOf(resolution, source),
		serialization: serializationOf(node, plan, resolution.line, origin, objectValue)
	})
}
