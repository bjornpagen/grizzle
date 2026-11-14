import { jsonTextOf } from "@superstarter/json"
import { regex } from "arkregex"
import { Array as Arr, JsonPointer, Option, Predicate, Record, String as Str } from "effect"
import { SafeText, sanitizeProse } from "#model/brands.ts"
import { isRefusal } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { DiscriminatorHint, Operation, Parameter, SecurityScheme } from "#model/entities.ts"
import type { NonStandardChoice, NonStandardUse } from "#model/non-standard.ts"
import { markedUses, nonStandardUses } from "#model/non-standard.ts"
import type { Json } from "#model/pointer.ts"

/**
 * The schema annotations of the body property a flag writes, read along its `$ref` chain: its
 * `enum` values, its `default` (never sent), and whether it is read-only or deprecated.
 */
export interface HelpBodyField {
	readonly default: Option.Option<Json>
	readonly deprecated: boolean
	readonly enum: readonly Json[] | undefined
	readonly readOnly: boolean
}

/**
 * Where a flag's value lands: a parameter (`negatable` for a three-state boolean), a body property
 * at an RFC 6901 pointer inside the body, with that property's annotations, the `Content-Type`
 * of the multipart part at `part`, one of `choices`, or the ordered parts of a positional
 * `multipart/mixed` body, `prefix[i]` the content type of part `i + 1` and `item` that of every
 * later part.
 */
export type HelpFlagSource =
	| { readonly _tag: "Body"; readonly field?: HelpBodyField; readonly pointer: string }
	| { readonly _tag: "Parameter"; readonly negatable: boolean; readonly parameter: Parameter }
	| { readonly _tag: "PartOption"; readonly option: HelpPartOption; readonly part: string }
	| { readonly _tag: "Parts"; readonly item?: string; readonly prefix: readonly string[] }

/**
 * What a multipart part option sets: the part's content type, one of `choices`, or the value of
 * its Encoding header `name`, needed when `required` and the part flag `partFlag` is given.
 */
export type HelpPartOption =
	| { readonly choices: readonly string[]; readonly kind: "content-type" }
	| {
			readonly deprecated: boolean
			readonly kind: "header"
			readonly name: string
			readonly partFlag: string
			readonly required: boolean
	  }

/**
 * A flag or argument by its visible name, without `--`.
 */
export interface HelpFlag {
	readonly name: string
	readonly source: HelpFlagSource
}

/**
 * The flag and environment names that carry one scheme's credential.
 */
export interface HelpCredential {
	readonly env: string
	readonly flag: string
	readonly scheme: string
}

/**
 * The environment names that carry one `mutualTLS` scheme's client certificate, key and CA paths;
 * it has no flag (design 6.5, D-SEC3).
 */
export interface HelpCertificate {
	readonly caEnv: string
	readonly certEnv: string
	readonly keyEnv: string
	readonly scheme: string
}

export interface HelpInput {
	readonly certificates?: readonly HelpCertificate[]
	readonly credentials: readonly HelpCredential[]
	readonly diagnostics: readonly Diagnostic[]
	readonly flags: readonly HelpFlag[]
	readonly operation: Operation
	readonly schemes: readonly SecurityScheme[]
}

/**
 * The strings for one command; m1-em4b places them as literals.
 */
export interface OperationHelp {
	readonly arguments: Readonly<Record<string, string>>
	/** The command's own help: the operation's description, else its summary. */
	readonly description: SafeTextValue
	readonly flags: Readonly<Record<string, string>>
	readonly sections: readonly (readonly [string, string])[]
	/**
	 * The one line a command table shows for the command, which is what OpenAPI's summary is: the summary, else the
	 * description's first sentence, else nothing.
	 */
	readonly summary: SafeTextValue
}

type SafeTextValue = typeof SafeText.Type

/**
 * The runs of LF and TAB a single-line field folds to one space.
 */
const lineBreaks = regex("[\\n\\t]+", "gu")

/**
 * A single-line generated field: sanitized, with LF and TAB runs folded to one space.
 */
const line = (text: string): string => Str.replaceAll(lineBreaks, " ")(sanitizeProse(text))

/** A sentence's end: a `.`, `!` or `?` with a space or the end of the text after it. */
const sentenceEnd = regex("[.!?](?=\\s|$)", "u")

/** Prose's first sentence: its first line, through the first sentence end on it, or the whole line where none is. */
const firstSentence = (text: string): string => {
	const [first] = Str.split("\n")(Str.trim(text))
	const end = Option.fromNullishOr(sentenceEnd.exec(first))

	return Option.match(end, {
		onNone: () => first,
		onSome: (found) => Str.slice(0, found.index + 1)(first)
	})
}

/**
 * Each switch's flag note (design 6.1 Scalar switch, Marking).
 */
const choiceNotes: Readonly<Record<NonStandardChoice, string>> = {
	deepObjectBrackets:
		"non-standard: sent as name[a][b]=v (author config nonStandard.deepObjectBrackets)",
	deepObjectScalars:
		"non-standard: a scalar value is sent as name=value (author config nonStandard.deepObjectScalars)"
}

const choices: readonly NonStandardChoice[] = ["deepObjectBrackets", "deepObjectScalars"]

/**
 * The distinct choices among use sites, bracket choice first.
 */
const choicesOf = (uses: readonly NonStandardUse[]): readonly NonStandardChoice[] =>
	Arr.filter(choices, (choice) => Arr.some(uses, (use) => use.choice === choice))

/**
 * The first pointer token, unescaped: the form property a body flag writes. The root pointer has
 * none and names the empty property.
 */
const propertyOf = (pointer: string): string =>
	JsonPointer.unescapeToken(Option.getOrElse(Arr.get(Str.split(pointer, "/"), 1), () => ""))

/**
 * The use sites the author config marked on the form property a body flag writes (design 6.1).
 */
const bodyMarked = (operation: Operation, pointer: string): readonly NonStandardUse[] => {
	const name = propertyOf(pointer)

	return Arr.flatMap(operation.body?.alternatives ?? [], (alternative) =>
		Arr.flatMap(alternative.encoding, (rule) =>
			rule.target.kind === "property" && rule.target.name === name ? markedUses(rule) : []
		)
	)
}

/**
 * The switches that marked the element a flag writes, bracket choice first; empty when unmarked.
 */
const markedChoices = (operation: Operation, flag: HelpFlag): readonly NonStandardChoice[] => {
	const { source } = flag
	if (source._tag === "Body") {
		return choicesOf(bodyMarked(operation, source.pointer))
	}

	if (source._tag === "PartOption" || source._tag === "Parts") {
		return []
	}

	return choicesOf(nonStandardUses(source.parameter.serialization))
}

/**
 * Each position's content type, then every later part's (HT:B15): `part 1: a; parts 2+: b`.
 */
const partsNote = (prefix: readonly string[], item: string | undefined): string => {
	const positions = Arr.map(prefix, (type, index) => `part ${index + 1}: ${line(type)}`)
	const rest = item === undefined ? [] : [`parts ${prefix.length + 1}+: ${line(item)}`]

	return Arr.join([...positions, ...rest], "; ")
}

const locationNote = (source: HelpFlagSource, name: string): string => {
	if (source._tag === "Body") {
		return `body ${line(source.pointer)}`
	}

	if (source._tag === "Parts") {
		return partsNote(source.prefix, source.item)
	}

	if (source._tag === "PartOption") {
		const part = `multipart part ${line(propertyOf(source.part))}`

		return source.option.kind === "header"
			? `header ${line(source.option.name)} of ${part}`
			: `content type of ${part}`
	}

	const { location, wireName } = source.parameter
	const note = `${location} ${line(wireName)}`

	return source.negatable ? `${note}; --no-${line(name)} sends false` : note
}

const record = (
	entries: readonly (readonly [string, string])[]
): Readonly<Record<string, string>> => Record.fromEntries(entries)

const mediaTypes = (alternatives: readonly { readonly mediaType: string }[]): string =>
	Arr.join(
		Arr.map(alternatives, (alternative) => alternative.mediaType),
		" or "
	)

const requestLine = (operation: Operation): string => {
	const { body, key, operationId } = operation
	const parts = [`${key.method} ${line(key.path)}`]
	if (body !== undefined) {
		const types = mediaTypes(body.alternatives)
		const required = body.required ? " (required)" : ""
		parts.push(`body${types === "" ? "" : ` ${types}`}${required}`)
	}

	if (operationId !== undefined) {
		parts.push(`operationId ${line(operationId)}`)
	}

	return Arr.join(parts, ", ")
}

type Hint = typeof DiscriminatorHint.Type

/**
 * One branch of a discriminated body: the JSON-quoted values that select it, then its component;
 * a branch no value selects names its place in the composition.
 */
const branchText = (hint: Hint, branch: Hint["branches"][number]): string => {
	const place = `${hint.keyword}/${branch.index}`
	if (branch.labels.length === 0) {
		return `${place} (inline, no ${line(hint.propertyName)} value)`
	}

	const values = Arr.join(
		Arr.map(branch.labels, (label) => line(jsonTextOf(label))),
		" | "
	)

	return `${values} (${branch.component === undefined ? place : line(branch.component)})`
}

/**
 * The VARIANTS line: each hinted body alternative's branches by discriminator value (D-OQ9).
 */
const variantsLine = (operation: Operation): string | undefined => {
	const hinted = Arr.flatMap(operation.body?.alternatives ?? [], ({ discriminator, mediaType }) => {
		if (discriminator === undefined) {
			return []
		}

		const branches = Arr.map(discriminator.branches, (branch) => branchText(discriminator, branch))

		return [
			`${mediaType} ${discriminator.keyword} by ${line(discriminator.propertyName)}: ${Arr.join(branches, ", ")}`
		]
	})

	return hinted.length === 0 ? undefined : Arr.join(hinted, "; ")
}

const kindNote = (scheme: SecurityScheme): string => {
	const { kind } = scheme
	if (kind.type === "apiKey") {
		return `apiKey ${kind.in} ${line(kind.name)}`
	}

	if (kind.type === "http") {
		return `http ${kind.scheme}`
	}

	if (kind.type === "oauth2Token") {
		return "oauth2 token"
	}

	return kind.type === "oidcToken" ? "oidc token" : "mutualTls"
}

/**
 * The marker column: what a reader must know about where a scheme came from and whether it is
 * deprecated.
 */
const markers = (scheme: SecurityScheme): readonly string[] => [
	...(scheme.source === "author-supplied" ? ["author-supplied"] : []),
	...(scheme.deprecated ? ["deprecated"] : [])
]

/**
 * The first entry per key, as a linear search would find it; built once per command.
 */
const firstByKey = <T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyMap<string, T> => {
	const map = new Map<string, T>()
	for (const item of items) {
		const key = keyOf(item)
		if (!map.has(key)) {
			map.set(key, item)
		}
	}

	return map
}

interface UseLookup {
	readonly certificates: ReadonlyMap<string, HelpCertificate>
	readonly credentials: ReadonlyMap<string, HelpCredential>
	readonly schemes: ReadonlyMap<string, SecurityScheme>
}

type Use = Operation["security"]["alternatives"][number]["uses"][number]

type Flows = Extract<SecurityScheme["kind"], { readonly type: "oauth2Token" }>["flows"]

/**
 * Flow kinds in a fixed order, so the line does not depend on the spec's key order.
 */
const flowKinds = [
	"authorizationCode",
	"clientCredentials",
	"deviceAuthorization",
	"implicit",
	"password"
] as const

const acquisition = "token acquisition is not supported; supply an access token"

/**
 * The URL fields a flow line shows, in a fixed order.
 */
const flowUrls = ["authorizationUrl", "deviceAuthorizationUrl", "tokenUrl", "refreshUrl"] as const

/**
 * One flow: its URLs when the spec gives them, then its scope names and descriptions (OAF-01,
 * OAF-12).
 */
const flowText = (kind: string, flow: NonNullable<Flows[keyof Flows]>): string => {
	const urls = Arr.flatMap(flowUrls, (field) => {
		const url = flow[field]

		return url === undefined ? [] : [`${field} ${line(url)}`]
	})
	const scopes =
		flow.scopes.length === 0
			? "none"
			: Arr.join(
					Arr.map(flow.scopes, ({ description, name }) =>
						description === "" ? line(name) : `${line(name)} (${line(description)})`
					),
					", "
				)

	return `${kind} flow ${Arr.join([...urls, `scopes ${scopes}`], ", ")}`
}

/**
 * What help shows of a scheme besides its sources: the oauth2 flows and metadata URL, the OIDC
 * discovery URL (neither URL is ever fetched, design 9 I3), and that no token is acquired.
 */
const kindDetails = (scheme: SecurityScheme): readonly string[] => {
	const { kind } = scheme
	if (kind.type === "oauth2Token") {
		const flows = Arr.flatMap(flowKinds, (flowKind) => {
			const flow = kind.flows[flowKind]

			return flow === undefined ? [] : [flowText(flowKind, flow)]
		})
		const metadata =
			kind.oauth2MetadataUrl === undefined
				? []
				: [`oauth2MetadataUrl ${line(kind.oauth2MetadataUrl)} (never fetched)`]

		return [...flows, ...metadata, acquisition]
	}

	return kind.type === "oidcToken"
		? [`openIdConnectUrl ${line(kind.openIdConnectUrl)} (never fetched)`, acquisition]
		: []
}

/**
 * The values of a requirement entry: required scopes for a token scheme (SEC-11), role names for
 * any other (SEC-13). Help shows them; they are never sent.
 */
const scopesNote = (scheme: SecurityScheme | undefined, scopes: readonly string[]): string[] => {
	if (scopes.length === 0) {
		return []
	}

	const type = scheme?.kind.type
	const label = type === "oauth2Token" || type === "oidcToken" ? "required scopes" : "roles"

	return [`${label} ${Arr.join(Arr.map(scopes, line), ", ")} (never sent)`]
}

/**
 * Where the credential is read from: a token scheme's file flag and env name, then the TTY prompt
 * when the scheme's credential sources hold it; a mutualTLS scheme's three env names and no flag.
 */
const sourcesOf = (
	lookup: UseLookup,
	scheme: SecurityScheme | undefined,
	name: string
): string | undefined => {
	const certificate = lookup.certificates.get(name)
	if (certificate !== undefined) {
		const envs = Arr.map([certificate.certEnv, certificate.keyEnv, certificate.caEnv], line)

		return `env ${Arr.join(envs, ", ")}; the certificate is presented only to accepted origins`
	}

	const credential = lookup.credentials.get(name)
	const prompt = scheme?.credentialSources.includes("prompt") === true ? ", TTY prompt" : ""

	return credential === undefined
		? undefined
		: `--${line(credential.flag)} <path|->, env ${line(credential.env)}${prompt}`
}

const useLine = (lookup: UseLookup, use: Use): string => {
	const name = use.scheme
	const scheme = lookup.schemes.get(name)
	const marked = scheme === undefined ? [] : markers(scheme)
	const mark = marked.length === 0 ? "" : ` [${Arr.join(marked, ", ")}]`
	const head = scheme === undefined ? line(name) : `${line(name)} (${kindNote(scheme)})${mark}`
	const sources = sourcesOf(lookup, scheme, name)
	const details = [
		...(scheme === undefined ? [] : kindDetails(scheme)),
		...scopesNote(scheme, use.scopes)
	]
	const text = sources === undefined ? head : `${head}: ${sources}`

	return details.length === 0 ? text : `${text}; ${Arr.join(details, "; ")}`
}

const anonymous = "no authentication"

/**
 * The AUTH line: the alternatives in document order, `{}` as no authentication; an explicit
 * `security: []` is no authentication and absent security is undocumented (D-OQ10 (a), design
 * 2.2).
 */
const authLine = (input: HelpInput): string => {
	const { alternatives, declared } = input.operation.security
	if (alternatives.length === 0) {
		return declared ? anonymous : "no authentication documented"
	}

	const lookup: UseLookup = {
		certificates: firstByKey(input.certificates ?? [], (certificate) => certificate.scheme),
		credentials: firstByKey(input.credentials, (credential) => credential.scheme),
		schemes: firstByKey(input.schemes, (scheme) => scheme.name)
	}

	return Arr.join(
		Arr.map(alternatives, (alternative) =>
			alternative.uses.length === 0
				? anonymous
				: Arr.join(
						Arr.map(alternative.uses, (use) => useLine(lookup, use)),
						" and "
					)
		),
		" or "
	)
}

const responseKey = (key: Operation["responses"][number]["key"]): string => {
	if (key === "default") {
		return key
	}

	return "code" in key ? String(key.code) : `${key.range}XX`
}

const responsesLine = (operation: Operation): string => {
	const cases = Arr.map(operation.responses, (response) => {
		const types = mediaTypes(response.alternatives)

		return types === "" ? responseKey(response.key) : `${responseKey(response.key)} ${types}`
	})

	return `${Arr.join(cases, "; ")}. Non-2xx exits 1 (401/403 exit 3)`
}

type ResponseHeader = Operation["responses"][number]["headers"][number]

const headerMarks = (header: ResponseHeader): string => {
	const marks = [
		...(header.required ? ["required"] : []),
		...(header.deprecated ? ["deprecated"] : [])
	]

	return marks.length === 0 ? header.name : `${header.name} (${Arr.join(marks, ", ")})`
}

/**
 * The RESPONSE HEADERS line: each case that declares headers, its names in document order with
 * their required and deprecated marks (HDR-04); absent when no case declares one.
 */
const responseHeadersLine = (operation: Operation): string | undefined => {
	const cases = Arr.map(
		Arr.filter(operation.responses, (response) => response.headers.length > 0),
		(response) =>
			`${responseKey(response.key)}: ${Arr.join(Arr.map(response.headers, headerMarks), ", ")}`
	)

	return cases.length === 0 ? undefined : Arr.join(cases, "; ")
}

const refusedLine = (input: HelpInput): string | undefined => {
	const { key } = input.operation
	const refused = Arr.filter(
		input.diagnostics,
		(diagnostic) =>
			isRefusal(diagnostic) &&
			(diagnostic.scope === "element" || diagnostic.scope === "field") &&
			diagnostic.operation?.method === key.method &&
			diagnostic.operation.path === key.path
	)

	return refused.length === 0
		? undefined
		: Arr.join(
				Arr.map(
					refused,
					(diagnostic) =>
						`${line(diagnostic.wire ?? diagnostic.element)}: ${line(diagnostic.message)}`
				),
				"; "
			)
}

const isArgument = (flag: HelpFlag): boolean =>
	flag.source._tag === "Parameter" && flag.source.parameter.location === "path"

const isDeprecated = ({ source }: HelpFlag): boolean => {
	if (source._tag === "PartOption") {
		return source.option.kind === "header" && source.option.deprecated
	}

	if (source._tag === "Parts") {
		return false
	}

	return source._tag === "Parameter"
		? source.parameter.deprecated
		: source.field?.deprecated === true
}

/**
 * A schema value as help shows it: a string as itself, anything else as JSON.
 */
const valueText = (value: Json): string =>
	line(Predicate.isString(value) ? value : jsonTextOf(value))

/**
 * A body field's schema notes: its allowed values, its default and its read-only mark. A content
 * type option lists its choices, and a required part header names the part flag it goes with.
 */
const fieldNotes = (source: HelpFlagSource): readonly string[] => {
	if (source._tag === "PartOption") {
		const { option } = source
		if (option.kind === "content-type") {
			return [`choices: ${Arr.join(Arr.map(option.choices, line), ", ")}`]
		}

		return option.required ? [`required when --${line(option.partFlag)} is given`] : []
	}

	const field = source._tag === "Body" ? source.field : undefined
	if (field === undefined) {
		return []
	}

	return [
		...(field.enum === undefined
			? []
			: [`choices: ${Arr.join(Arr.map(field.enum, valueText), ", ")}`]),
		...Option.match(field.default, {
			onNone: () => [],
			onSome: (value) => [`default: ${valueText(value)}`]
		}),
		...(field.readOnly ? ["read-only"] : [])
	]
}

/**
 * A flag's annotation: its location, then each switch's note, the body field's schema notes and
 * `deprecated` when they apply.
 */
const noted =
	(operation: Operation) =>
	(flag: HelpFlag): readonly [string, string] => {
		const notes = [
			locationNote(flag.source, flag.name),
			...Arr.map(markedChoices(operation, flag), (choice) => choiceNotes[choice]),
			...fieldNotes(flag.source),
			...(isDeprecated(flag) ? ["deprecated"] : [])
		]

		return [line(flag.name), Arr.join(notes, "; ")]
	}

/**
 * The NON-STANDARD line: for each switch, the flags it marked by visible name, then its choice.
 */
const nonStandardLine = (input: HelpInput): string | undefined => {
	const groups = Arr.flatMap(choices, (choice) => {
		const marked = Arr.filter(input.flags, (flag) =>
			markedChoices(input.operation, flag).includes(choice)
		)
		const names = Arr.map(marked, (flag) => `--${line(flag.name)}`)

		return marked.length === 0 ? [] : [`${Arr.join(names, ", ")} (${choice})`]
	})

	return groups.length === 0 ? undefined : Arr.join(groups, "; ")
}

/**
 * The description and generated notes of one command, from the model alone: source prose first,
 * then the wire name and location of each argument and flag (with a body field's allowed values,
 * default and read-only and deprecated marks), and the REQUEST, VARIANTS, AUTH, RESPONSES,
 * RESPONSE HEADERS and REFUSED lines. VARIANTS lists a discriminated body's branches and is absent
 * without a hint; RESPONSE HEADERS is absent when no case declares a header; the REFUSED line lists
 * the command's refused elements and refused body fields by wire name and reason.
 */
export const operationHelp = (input: HelpInput): OperationHelp => {
	const { operation } = input
	const auth = authLine(input)
	const refused = refusedLine(input)
	const nonStandard = nonStandardLine(input)
	const responseHeaders = responseHeadersLine(operation)
	const variants = variantsLine(operation)
	const sections: (readonly [string, string])[] = [
		["REQUEST", requestLine(operation)],
		...(variants === undefined ? [] : [["VARIANTS", variants] as const]),
		["AUTH", auth]
	]

	if (operation.deprecated) {
		sections.push([
			"DEPRECATED",
			"this command is deprecated; running it writes a notice to stderr"
		])
	}

	sections.push(["RESPONSES", responsesLine(operation)])
	if (responseHeaders !== undefined) {
		sections.push(["RESPONSE HEADERS", responseHeaders])
	}

	if (nonStandard !== undefined) {
		sections.push(["NON-STANDARD", nonStandard])
	}

	if (refused !== undefined) {
		sections.push(["REFUSED", refused])
	}

	return {
		arguments: record(Arr.map(Arr.filter(input.flags, isArgument), noted(operation))),
		description: sanitizeProse(operation.docs.description ?? operation.docs.summary ?? ""),
		summary: sanitizeProse(
			line(operation.docs.summary ?? firstSentence(operation.docs.description ?? ""))
		),
		flags: record(
			Arr.map(
				Arr.filter(input.flags, (flag) => !isArgument(flag)),
				noted(operation)
			)
		),
		sections
	}
}
