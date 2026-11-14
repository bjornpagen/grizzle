/**
 * Help as a function of the model. A generated operation, with its flags, the declared schemes, the credentials and
 * certificates the names plan gave them and the run's diagnostics, renders to help whose contract is checked fact by
 * fact: the description is the source description, else the summary, sanitized; the sections are REQUEST, VARIANTS
 * when a body alternative is discriminated, AUTH, DEPRECATED when the operation is, RESPONSES, RESPONSE HEADERS when a
 * case declares one, NON-STANDARD when a switch marked a flag and REFUSED when an element or field of this operation was
 * refused, in that order; every section and every note is one line of safe text; path parameters are arguments and
 * everything else a flag; each note names its location first, then each switch's note, the body field's choices,
 * default and read-only mark, and `deprecated` last when it applies; REQUEST names the method, path, body media types
 * and operation id; AUTH names each alternative's schemes with their markers, credential sources, flows, scopes and
 * roles; RESPONSES names each case in order; REFUSED names each refused element of this operation and nothing else.
 * `sanitizeProse`, which every help field goes through, keeps exactly the safe code points of its input, in order, up
 * to its cap.
 *
 * An operation's docs are drawn as normalization holds them, sanitized and so never past the cap: a description at the
 * cap is one the cap cut.
 *
 * Plants, each applied to src/emit/help.ts or src/model/brands.ts, seen to fail this suite and reverted:
 * - help's description cut one code point short of the cap (a description at the cap);
 * - help's description taken from the summary before the description;
 * - brands.ts's maxProseLength at 1999 (sanitizing prose, and no description reaches the cap);
 * - a scheme's `deprecated` marker left out of AUTH.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import {
	array,
	boolean,
	characterOf,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	subarray,
	uniqueArray,
	weighted
} from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import { regex } from "arkregex"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	JsonPointer as Pointers,
	Option,
	Order,
	Predicate,
	Record,
	String as Str
} from "effect"
import { operationHelp } from "#emit/help.ts"
import type {
	HelpCertificate,
	HelpCredential,
	HelpFlag,
	HelpFlagSource,
	HelpInput
} from "#emit/help.ts"
import {
	DocumentUri,
	HeaderName,
	JsonPointer,
	MediaType,
	MethodToken,
	PathTemplate,
	SafeText,
	WireName,
	sanitizeProse
} from "#model/brands.ts"
import { Diagnostic } from "#model/diagnostic.ts"
import {
	Body,
	EncodingRule,
	MediaAlternative,
	Operation,
	Parameter,
	ResponseCase,
	RowId,
	SecurityPolicy,
	SecurityScheme,
	StyleSerialization
} from "#model/entities.ts"
import type { Json } from "#model/pointer.ts"

const document = DocumentUri.make("file:///help/openapi.json")

const origin = { document, pointer: JsonPointer.make("/paths") }

/** Characters help must keep out of a terminal line, beside plain, wide and separator characters. */
const HOSTILE: ReadonlyArray<string> = [
	"\n",
	"\t",
	"\u0007",
	"\u001b",
	"\u007f",
	"\u200e",
	"\u202e",
	"\u2028",
	"\u2029",
	"\ud800"
]

const TEXT_CHARS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	" ",
	"é",
	"中",
	"-",
	".",
	...HOSTILE
]

/** Text a spec may hold: plain, wide, and hostile. */
const text: Gen<string> = string(characterOf(TEXT_CHARS), { min: 1, max: 8 })

/** Text the model already holds as safe: sanitized at normalization, LF and TAB kept. */
const safeText: Gen<typeof SafeText.Type> = map(text, sanitizeProse)

const WIRE_CHARS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	" ",
	"é",
	"中",
	"-",
	".",
	"\u200e",
	"\u202e",
	"\u2028"
]

/** A wire name: no control or lone surrogate, as the model admits, but format characters and separators kept. */
const wireName: Gen<string> = string(characterOf(WIRE_CHARS), { min: 1, max: 6 })

const FLAG_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"name",
	"limit",
	"if-match",
	"address.city",
	"file",
	"file-content-type",
	"file-x-trace",
	"x-trace",
	"part",
	"id"
]

const SCHEME_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"bearerAuth",
	"apiKey",
	"oauth",
	"oidc",
	"mtls",
	"basic"
]

/** The OAuth flow kinds, in the order help lists them. */
const FLOW_KINDS = [
	"authorizationCode",
	"clientCredentials",
	"deviceAuthorization",
	"implicit",
	"password"
] as const

type SchemeKind = SecurityScheme["kind"]

const schemeKindGen: Gen<SchemeKind> = oneOf<SchemeKind>([
	(s) => ({
		in: "header",
		name: HeaderName.make(s.draw(element(["X-API-Key", "Token"]))),
		type: "apiKey"
	}),
	(s) => ({ in: "query", name: WireName.make(s.draw(wireName)), type: "apiKey" }),
	(s) => ({ scheme: s.draw(element<"basic" | "bearer">(["basic", "bearer"])), type: "http" }),
	(s) => ({
		flows: Record.fromEntries(
			Arr.map(
				s.draw(subarray(FLOW_KINDS)),
				(flow) =>
					[
						flow,
						{
							...Record.fromEntries(
								Arr.map(
									s.draw(subarray(["authorizationUrl", "tokenUrl", "refreshUrl"] as const)),
									(url) => [url, s.draw(safeText)] as const
								)
							),
							scopes: s.draw(
								array((t) => ({ description: t.draw(safeText), name: t.draw(safeText) }), {
									min: 0,
									max: 2
								})
							)
						}
					] as const
			)
		),
		...Option.match(s.draw(option(safeText)), {
			onNone: () => ({}),
			onSome: (oauth2MetadataUrl) => ({ oauth2MetadataUrl })
		}),
		type: "oauth2Token"
	}),
	(s) => ({ openIdConnectUrl: s.draw(safeText), type: "oidcToken" }),
	() => ({ type: "mutualTls" })
])

const schemesGen: Gen<ReadonlyArray<SecurityScheme>> = uniqueArray(
	element(SCHEME_NAMES),
	(name) => (s) =>
		SecurityScheme.make({
			credentialSources: s.draw(subarray(["file", "env", "prompt"])),
			deprecated: s.draw(boolean),
			kind: s.draw(schemeKindGen),
			name,
			origin,
			rows: [],
			source: s.draw(element<"spec" | "author-supplied">(["spec", "author-supplied"]))
		}),
	{ min: 0, max: 4 }
)

const PROPERTIES: Arr.NonEmptyReadonlyArray<string> = ["name", "address", "file", "tags", "a~1b"]

const STYLES: Arr.NonEmptyReadonlyArray<StyleSerialization["style"]> = [
	"form",
	"simple",
	"deepObject",
	"label"
]

/** The markers the author config's switches leave on a serialization or an Encoding rule. */
const marksGen: Gen<
	Readonly<{ nonStandard?: "deepObjectBrackets"; nonStandardScalars?: "deepObjectScalars" }>
> = (s) => ({
	...(s.draw(
		weighted([
			[3, () => false],
			[1, () => true]
		])
	)
		? { nonStandard: "deepObjectBrackets" as const }
		: {}),
	...(s.draw(
		weighted([
			[3, () => false],
			[1, () => true]
		])
	)
		? { nonStandardScalars: "deepObjectScalars" as const }
		: {})
})

const parameterGen =
	(location: Parameter["location"]): Gen<Parameter> =>
	(s) =>
		Parameter.make({
			deprecated: s.draw(boolean),
			docs: {},
			location,
			origin,
			required: location === "path" || s.draw(boolean),
			rows: [],
			schema: { key: "s" },
			serialization: StyleSerialization.make({
				allowReserved: false,
				explode: s.draw(boolean),
				kind: "style",
				objectValued: s.draw(boolean),
				origin,
				rows: [],
				rules: "rules",
				style: s.draw(element(STYLES)),
				...s.draw(marksGen)
			}),
			wireName: WireName.make(s.draw(wireName))
		})

const jsonValue: Gen<Json> = oneOf<Json>([
	map(text, (value) => value),
	int(-5, 50),
	boolean,
	() => null
])

const MEDIA_TYPES: Arr.NonEmptyReadonlyArray<string> = [
	"application/json",
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"image/png",
	"text/plain"
]

const sourceGen: Gen<HelpFlagSource> = weighted<HelpFlagSource>([
	[
		4,
		(s) => {
			const location = s.draw(
				element<Parameter["location"]>(["path", "query", "header", "cookie", "querystring"])
			)
			return {
				_tag: "Parameter",
				negatable: location !== "path" && s.draw(boolean),
				parameter: s.draw(parameterGen(location))
			}
		}
	],
	[
		4,
		(s) => ({
			_tag: "Body",
			pointer: `/${s.draw(element(PROPERTIES))}${s.draw(element(["", "/city", "/0"]))}`,
			...Option.match(
				s.draw(
					option((t) => ({
						default: t.draw(option(jsonValue)),
						deprecated: t.draw(boolean),
						enum: t.draw(
							weighted<ReadonlyArray<Json> | undefined>([
								[2, () => undefined],
								[1, array(jsonValue, { min: 1, max: 3 })]
							])
						),
						readOnly: t.draw(boolean)
					}))
				),
				{ onNone: () => ({}), onSome: (field) => ({ field }) }
			)
		})
	],
	[
		1,
		(s) => ({
			_tag: "PartOption",
			part: `/${s.draw(element(PROPERTIES))}`,
			option: {
				choices: s.draw(array(element(MEDIA_TYPES), { min: 1, max: 3 })),
				kind: "content-type"
			}
		})
	],
	[
		1,
		(s) => ({
			_tag: "PartOption",
			part: `/${s.draw(element(PROPERTIES))}`,
			option: {
				deprecated: s.draw(boolean),
				kind: "header",
				name: s.draw(element(["X-Trace", "X-Checksum"])),
				partFlag: s.draw(element(FLAG_NAMES)),
				required: s.draw(boolean)
			}
		})
	],
	[
		1,
		(s) => ({
			_tag: "Parts",
			prefix: s.draw(array(element(MEDIA_TYPES), { min: 0, max: 2 })),
			...Option.match(s.draw(option(element(MEDIA_TYPES))), {
				onNone: () => ({}),
				onSome: (item) => ({ item })
			})
		})
	]
])

const flagsGen: Gen<ReadonlyArray<HelpFlag>> = uniqueArray(
	element(FLAG_NAMES),
	(name) => map(sourceGen, (source): HelpFlag => ({ name, source })),
	{ min: 0, max: 6 }
)

const alternativeGen =
	(codec: MediaAlternative["codec"]) =>
	(mediaType: string): Gen<MediaAlternative> =>
	(s) =>
		MediaAlternative.make({
			codec,
			encoding: Arr.map(s.draw(subarray(PROPERTIES)), (name) =>
				EncodingRule.make({
					contentType: [],
					headers: [],
					origin,
					rows: [],
					target: { kind: "property", name: WireName.make(name) },
					...s.draw(marksGen)
				})
			),
			mediaType: MediaType.make(mediaType),
			origin,
			prefixEncoding: [],
			rows: [],
			...Option.match(
				s.draw(
					option((t) => ({
						branches: t.draw(
							array(
								(u) => ({
									index: u.draw(int(0, 3)),
									labels: u.draw(array(text, { min: 0, max: 2 })),
									...Option.match(u.draw(option(text)), {
										onNone: () => ({}),
										onSome: (component) => ({ component })
									})
								}),
								{ min: 1, max: 3 }
							)
						),
						keyword: t.draw(element<"allOf" | "anyOf" | "oneOf">(["allOf", "anyOf", "oneOf"])),
						propertyName: t.draw(text)
					}))
				),
				{
					onNone: () => ({}),
					onSome: (discriminator) => (codec === "json" ? { discriminator } : {})
				}
			)
		})

const bodyGen: Gen<Body> = (s) =>
	Body.make({
		alternatives: s.draw(
			uniqueArray(element(MEDIA_TYPES), alternativeGen("json"), { min: 0, max: 3 })
		),
		docs: {},
		origin,
		required: s.draw(boolean),
		rows: []
	})

const responseKeyGen: Gen<ResponseCase["key"]> = oneOf<ResponseCase["key"]>([
	map(element([200, 201, 204, 401, 404, 500]), (code) => ({ code })),
	map(int(1, 5), (range) => ({ range })),
	() => "default"
])

const responseGen: Gen<ResponseCase> = (s) =>
	ResponseCase.make({
		alternatives: s.draw(
			uniqueArray(element(MEDIA_TYPES), alternativeGen("json"), { min: 0, max: 2 })
		),
		docs: {},
		headers: s.draw(
			uniqueArray(
				element(["X-Request-ID", "ETag", "Retry-After"]),
				(name) => (t) => ({
					deprecated: t.draw(boolean),
					name: HeaderName.make(name),
					required: t.draw(boolean)
				}),
				{ min: 0, max: 2 }
			)
		),
		key: s.draw(responseKeyGen),
		origin,
		rows: []
	})

const securityGen =
	(schemes: ReadonlyArray<SecurityScheme>): Gen<SecurityPolicy> =>
	(s) =>
		SecurityPolicy.make({
			alternatives: s.draw(
				array(
					(t) => ({
						uses: t.draw(
							uniqueArray(
								weighted([
									[
										4,
										element(
											Arr.isReadonlyArrayNonEmpty(schemes)
												? Arr.map(schemes, (scheme) => scheme.name)
												: SCHEME_NAMES
										)
									],
									[1, element(["undeclared"])]
								]),
								(scheme) => (u) => ({ scheme, scopes: u.draw(array(text, { min: 0, max: 2 })) }),
								{ min: 0, max: 2 }
							)
						)
					}),
					{ min: 0, max: 3 }
				)
			),
			declared: s.draw(boolean),
			origin,
			rows: []
		})

const METHODS: Arr.NonEmptyReadonlyArray<string> = ["GET", "POST", "PATCH", "DELETE", "QUERY"]

const PATHS: Arr.NonEmptyReadonlyArray<string> = ["/users/{id}", "/pets", "/a/{b}/c"]

/** The code points prose keeps (src/model/brands.ts `maxProseLength`). */
const MAX_PROSE = 2000

/**
 * An operation's docs as normalization holds them: sanitized, so a description longer than the cap was cut to it, and
 * the model never holds one past it.
 */
const docsGen: Gen<Operation["docs"]> = (s) => {
	const long = s.draw(
		weighted([
			[6, () => false],
			[1, () => true]
		])
	)
	const prose = long
		? map(text, (start) => sanitizeProse(`${start}${Str.repeat(MAX_PROSE + 100)("x")}`))
		: safeText
	return {
		...Option.match(s.draw(option(prose)), {
			onNone: () => ({}),
			onSome: (description) => ({ description })
		}),
		...Option.match(s.draw(option(safeText)), {
			onNone: () => ({}),
			onSome: (summary) => ({ summary })
		})
	}
}

const ROWS: Arr.NonEmptyReadonlyArray<string> = ["PRM-1", "ENC-3", "SCH-29"]

/** A diagnostic of this operation or another, a refusal or a notice, at any scope. */
const diagnosticGen =
	(key: Operation["key"]): Gen<Diagnostic> =>
	(s) => {
		const row = s.draw(element(ROWS))
		const other = s.draw(
			weighted([
				[3, () => false],
				[1, () => true]
			])
		)
		return Diagnostic.make({
			code: `${row}/refused`,
			document,
			element: s.draw(text),
			message: s.draw(text),
			openapi: "3.1.0",
			operation: { method: key.method, path: other ? "/elsewhere" : key.path },
			pointer: JsonPointer.make("/paths"),
			row: RowId.make(row),
			scope: s.draw(element<Diagnostic["scope"]>(["element", "field", "operation", "document"])),
			severity: s.draw(element<Diagnostic["severity"]>(["refusal", "notice"])),
			specSection: DocumentUri.make("https://spec.openapis.org/oas/v3.1.0"),
			...Option.match(s.draw(option(text)), { onNone: () => ({}), onSome: (wire) => ({ wire }) })
		})
	}

const helpInputGen: Gen<HelpInput> = (s) => {
	const schemes = s.draw(schemesGen)
	const key = {
		method: MethodToken.make(s.draw(element(METHODS))),
		path: PathTemplate.make(s.draw(element(PATHS)))
	}
	const tokenSchemes = Arr.filter(schemes, (scheme) => scheme.kind.type !== "mutualTls")
	const mtlsSchemes = Arr.filter(schemes, (scheme) => scheme.kind.type === "mutualTls")
	const credentials: ReadonlyArray<HelpCredential> = Arr.map(
		s.draw(subarray(tokenSchemes)),
		(scheme, index) => ({
			env: `ENV_${index}`,
			flag: `${scheme.name}-file`,
			scheme: scheme.name
		})
	)
	const certificates: ReadonlyArray<HelpCertificate> = Arr.map(
		s.draw(subarray(mtlsSchemes)),
		(scheme, index) => ({
			caEnv: `CA_${index}`,
			certEnv: `CERT_${index}`,
			keyEnv: `KEY_${index}`,
			scheme: scheme.name
		})
	)
	return {
		certificates,
		credentials,
		diagnostics: s.draw(array(diagnosticGen(key), { min: 0, max: 4 })),
		flags: s.draw(flagsGen),
		operation: Operation.make({
			deprecated: s.draw(boolean),
			docs: s.draw(docsGen),
			key,
			origin,
			parameters: [],
			responses: s.draw(array(responseGen, { min: 0, max: 3 })),
			rows: [],
			security: s.draw(securityGen(schemes)),
			servers: [],
			tags: [],
			...Option.match(s.draw(option(bodyGen)), {
				onNone: () => ({}),
				onSome: (body) => ({ body })
			}),
			...Option.match(s.draw(option(text)), {
				onNone: () => ({}),
				onSome: (operationId) => ({ operationId })
			})
		}),
		schemes
	}
}

const lineBreaks = regex("[\\n\\t]+", "gu")

/** A single-line field as help's contract states it: sanitized, each run of LF and TAB folded to one space. */
const line = (value: string): string => Str.replaceAll(lineBreaks, " ")(sanitizeProse(value))

const unsafe = regex("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]", "u")

const isOneSafeLine = (value: string): boolean => !unsafe.test(value)

const propertyOf = (pointer: string): string =>
	Pointers.unescapeToken(Option.getOrElse(Arr.get(Str.split("/")(pointer), 1), () => ""))

type Choice = "deepObjectBrackets" | "deepObjectScalars"

const CHOICES: ReadonlyArray<Choice> = ["deepObjectBrackets", "deepObjectScalars"]

const marksOf = (
	element: Readonly<{ nonStandard?: string; nonStandardScalars?: string }>
): ReadonlyArray<Choice> =>
	Arr.filter(CHOICES, (choice) =>
		choice === "deepObjectBrackets"
			? element.nonStandard !== undefined
			: element.nonStandardScalars !== undefined
	)

/** The switches design 6.1 says marked the element a flag writes: its parameter's, or the form rules of its body
 * property. */
const choicesOf = (operation: Operation, flag: HelpFlag): ReadonlyArray<Choice> => {
	const { source } = flag
	if (source._tag === "Parameter") {
		return source.parameter.serialization.kind === "style"
			? marksOf(source.parameter.serialization)
			: []
	}
	if (source._tag !== "Body") {
		return []
	}
	const name = propertyOf(source.pointer)
	const rules = Arr.flatMap(operation.body?.alternatives ?? [], (alternative) =>
		Arr.filter(
			alternative.encoding,
			(rule) => rule.target.kind === "property" && rule.target.name === name
		)
	)
	return Arr.filter(CHOICES, (choice) =>
		Arr.some(rules, (rule) => Arr.contains(marksOf(rule), choice))
	)
}

const isArgument = (flag: HelpFlag): boolean =>
	flag.source._tag === "Parameter" && flag.source.parameter.location === "path"

const isDeprecated = (source: HelpFlagSource): boolean => {
	switch (source._tag) {
		case "Parameter":
			return source.parameter.deprecated
		case "Body":
			return source.field?.deprecated === true
		case "PartOption":
			return source.option.kind === "header" && source.option.deprecated
		case "Parts":
			return false
	}
}

/** Where a flag's value lands, as its note must begin. */
const locationOf = (flag: HelpFlag): string => {
	const { source } = flag
	switch (source._tag) {
		case "Parameter":
			return `${source.parameter.location} ${line(source.parameter.wireName)}`
		case "Body":
			return `body ${line(source.pointer)}`
		case "PartOption":
			return source.option.kind === "header"
				? `header ${line(source.option.name)} of multipart part ${line(propertyOf(source.part))}`
				: `content type of multipart part ${line(propertyOf(source.part))}`
		case "Parts":
			return Arr.isReadonlyArrayNonEmpty(source.prefix)
				? `part 1: ${line(Arr.headNonEmpty(source.prefix))}`
				: source.item === undefined
					? ""
					: `parts 1+: ${line(source.item)}`
	}
}

const valueText = (value: Json): string =>
	line(Predicate.isString(value) ? value : jsonTextOf(value))

/** Every fact a flag's note must state and none it must not. */
const noteFindings = (
	operation: Operation,
	flag: HelpFlag,
	note: string
): ReadonlyArray<string> => {
	const { source } = flag
	const field = source._tag === "Body" ? Option.fromUndefinedOr(source.field) : Option.none()
	const choices = choicesOf(operation, flag)
	const at = `--${flag.name}`
	return [
		...(Str.startsWith(locationOf(flag))(note) ? [] : [`${at}: does not start with its location`]),
		...(isOneSafeLine(note) ? [] : [`${at}: not one safe line`]),
		...(source._tag === "Parameter" &&
		source.negatable &&
		!Str.includes(`--no-${flag.name} sends false`)(note)
			? [`${at}: a negatable flag without its --no- form`]
			: []),
		...Arr.flatMap(CHOICES, (choice) =>
			Arr.contains(choices, choice) === Str.includes(`nonStandard.${choice}`)(note)
				? []
				: [`${at}: the ${choice} note`]
		),
		...(Str.endsWith("deprecated")(note) === isDeprecated(source)
			? []
			: [`${at}: the deprecated mark`]),
		...Option.match(field, {
			onNone: () => [],
			onSome: (value) => [
				...((value.enum === undefined) === !Str.includes("choices: ")(note)
					? []
					: [`${at}: the choices`]),
				...Arr.flatMap(value.enum ?? [], (choice) =>
					Str.includes(valueText(choice))(note) ? [] : [`${at}: a choice`]
				),
				...Option.match(value.default, {
					onNone: () =>
						Str.includes("default: ")(note) ? [`${at}: a default it has none of`] : [],
					onSome: (fallback) =>
						Str.includes(`default: ${valueText(fallback)}`)(note) ? [] : [`${at}: its default`]
				}),
				...(value.readOnly === Str.includes("; read-only")(note)
					? []
					: [`${at}: the read-only mark`])
			]
		}),
		...(source._tag === "PartOption" &&
		source.option.kind === "header" &&
		source.option.required &&
		!Str.includes(`required when --${source.option.partFlag} is given`)(note)
			? [`${at}: a required part header without its part`]
			: []),
		...(source._tag === "PartOption" &&
		source.option.kind === "content-type" &&
		!Str.includes("choices: ")(note)
			? [`${at}: a content type option without its choices`]
			: [])
	]
}

const isRefusedHere =
	(operation: Operation) =>
	(diagnostic: Diagnostic): boolean =>
		diagnostic.severity === "refusal" &&
		(diagnostic.scope === "element" || diagnostic.scope === "field") &&
		diagnostic.operation?.method === operation.key.method &&
		diagnostic.operation.path === operation.key.path

const responseKeyText = (key: ResponseCase["key"]): string =>
	key === "default" ? key : "code" in key ? String(key.code) : `${key.range}XX`

/** The sections help must hold, in order, from the model's facts. */
const sectionsOf = (input: HelpInput): ReadonlyArray<string> => {
	const { operation } = input
	return [
		"REQUEST",
		...(Arr.some(
			operation.body?.alternatives ?? [],
			(alternative) => alternative.discriminator !== undefined
		)
			? ["VARIANTS"]
			: []),
		"AUTH",
		...(operation.deprecated ? ["DEPRECATED"] : []),
		"RESPONSES",
		...(Arr.some(operation.responses, (response) => Arr.isReadonlyArrayNonEmpty(response.headers))
			? ["RESPONSE HEADERS"]
			: []),
		...(Arr.some(input.flags, (flag) => Arr.isReadonlyArrayNonEmpty(choicesOf(operation, flag)))
			? ["NON-STANDARD"]
			: []),
		...(Arr.some(input.diagnostics, isRefusedHere(operation)) ? ["REFUSED"] : [])
	]
}

const kindNote = (kind: SchemeKind): string => {
	switch (kind.type) {
		case "apiKey":
			return `apiKey ${kind.in} ${line(kind.name)}`
		case "http":
			return `http ${kind.scheme}`
		case "oauth2Token":
			return "oauth2 token"
		case "oidcToken":
			return "oidc token"
		case "mutualTls":
			return "mutualTls"
	}
}

/** Every fact one use of a scheme must state on the AUTH line. */
const useFindings = (
	input: HelpInput,
	use: Readonly<{ scheme: string; scopes: ReadonlyArray<string> }>,
	text: string
): ReadonlyArray<string> => {
	const scheme = Arr.findFirst(input.schemes, (declared) => declared.name === use.scheme)
	const credential = Arr.findFirst(input.credentials, (entry) => entry.scheme === use.scheme)
	const certificate = Arr.findFirst(
		input.certificates ?? [],
		(entry) => entry.scheme === use.scheme
	)
	const at = `AUTH ${use.scheme}`
	return [
		...(Str.startsWith(line(use.scheme))(text) ? [] : [`${at}: does not start with the scheme`]),
		...Option.match(scheme, {
			onNone: () => [],
			onSome: (declared) => {
				const marks = [
					...(declared.source === "author-supplied" ? ["author-supplied"] : []),
					...(declared.deprecated ? ["deprecated"] : [])
				]
				const token = declared.kind.type === "oauth2Token" || declared.kind.type === "oidcToken"
				return [
					...(Str.includes(`(${kindNote(declared.kind)})`)(text) ? [] : [`${at}: its kind`]),
					...(Str.includes(`[${Arr.join(marks, ", ")}]`)(text) ===
					Arr.isReadonlyArrayNonEmpty(marks)
						? []
						: [`${at}: its markers`]),
					...(Str.includes("token acquisition is not supported")(text) === token
						? []
						: [`${at}: the acquisition note`]),
					...(declared.kind.type === "oauth2Token"
						? flowFindings(declared.kind.flows, text, at)
						: []),
					...(Arr.isReadonlyArrayNonEmpty(use.scopes) &&
					!Str.includes(
						`${token ? "required scopes" : "roles"} ${Arr.join(Arr.map(use.scopes, line), ", ")} (never sent)`
					)(text)
						? [`${at}: its scopes`]
						: []),
					...(Option.isSome(credential) &&
					Str.includes("TTY prompt")(text) !== Arr.contains(declared.credentialSources, "prompt")
						? [`${at}: the TTY prompt`]
						: [])
				]
			}
		}),
		...Option.match(credential, {
			onNone: () => [],
			onSome: (entry) =>
				Str.includes(`--${line(entry.flag)} <path|->, env ${line(entry.env)}`)(text)
					? []
					: [`${at}: its credential sources`]
		}),
		...Option.match(certificate, {
			onNone: () => [],
			onSome: (entry) =>
				Str.includes(`env ${entry.certEnv}, ${entry.keyEnv}, ${entry.caEnv}`)(text)
					? []
					: [`${at}: its certificate environment`]
		})
	]
}

type OAuthKind = Extract<SchemeKind, { type: "oauth2Token" }>

/** Each flow an oauth2 scheme declares that its AUTH text does not name. */
const flowFindings = (flows: OAuthKind["flows"], text: string, at: string): ReadonlyArray<string> =>
	Arr.flatMap(FLOW_KINDS, (flow) =>
		flows[flow] === undefined || Str.includes(`${flow} flow`)(text)
			? []
			: [`${at}: its ${flow} flow`]
	)

const authFindings = (input: HelpInput, text: string): ReadonlyArray<string> => {
	const { alternatives, declared } = input.operation.security
	if (!Arr.isReadonlyArrayNonEmpty(alternatives)) {
		return text === (declared ? "no authentication" : "no authentication documented")
			? []
			: ["AUTH: absent or empty security"]
	}
	const parts = Str.split(" or ")(text)
	return parts.length === alternatives.length
		? Arr.flatMap(Arr.zip(alternatives, parts), ([alternative, part]) => {
				if (!Arr.isReadonlyArrayNonEmpty(alternative.uses)) {
					return part === "no authentication" ? [] : ["AUTH: an anonymous alternative"]
				}
				const uses = Str.split(" and ")(part)
				return uses.length === alternative.uses.length
					? Arr.flatMap(Arr.zip(alternative.uses, uses), ([use, useText]) =>
							useFindings(input, use, useText)
						)
					: ["AUTH: an alternative's schemes"]
			})
		: ["AUTH: the alternatives"]
}

const requestFindings = (operation: Operation, text: string): ReadonlyArray<string> => [
	...(Str.startsWith(`${operation.key.method} ${line(operation.key.path)}`)(text)
		? []
		: ["REQUEST: the method and path"]),
	...(Str.includes(", body")(text) === (operation.body !== undefined) ? [] : ["REQUEST: the body"]),
	...(Str.includes("(required)")(text) === (operation.body?.required === true)
		? []
		: ["REQUEST: the required mark"]),
	...Arr.flatMap(operation.body?.alternatives ?? [], (alternative) =>
		Str.includes(alternative.mediaType)(text) ? [] : ["REQUEST: a body media type"]
	),
	...(operation.operationId === undefined ||
	Str.includes(`operationId ${line(operation.operationId)}`)(text)
		? []
		: ["REQUEST: the operation id"])
]

const responsesFindings = (operation: Operation, text: string): ReadonlyArray<string> => {
	const tail = ". Non-2xx exits 1 (401/403 exit 3)"
	const cases = Str.split("; ")(Str.slice(0, -tail.length)(text))
	return [
		...(Str.endsWith(tail)(text) ? [] : ["RESPONSES: the exit note"]),
		...(cases.length === Math.max(1, operation.responses.length) &&
		Arr.every(Arr.zip(operation.responses, cases), ([response, entry]) =>
			Str.startsWith(responseKeyText(response.key))(entry)
		)
			? []
			: ["RESPONSES: the cases"])
	]
}

const refusedFindings = (input: HelpInput, text: string): ReadonlyArray<string> => {
	const refused = Arr.filter(input.diagnostics, isRefusedHere(input.operation))
	const entries = Str.split("; ")(text)
	return entries.length === refused.length &&
		Arr.every(
			Arr.zip(refused, entries),
			([diagnostic, entry]) =>
				entry === `${line(diagnostic.wire ?? diagnostic.element)}: ${line(diagnostic.message)}`
		)
		? []
		: ["REFUSED: the refusals"]
}

/** Every way the help of an input breaks its contract, by section and flag. */
const helpFindings = (
	input: HelpInput,
	help: ReturnType<typeof operationHelp>
): ReadonlyArray<string> => {
	const { operation } = input
	const sections = Record.fromEntries(help.sections)
	const notes = { ...help.arguments, ...help.flags }
	const section = (name: string) => Option.getOrElse(Record.get(sections, name), () => "")
	return [
		...Arr.flatMap(help.sections, ([name, value]) =>
			isOneSafeLine(value) ? [] : [`${name}: not one safe line`]
		),
		...Arr.flatMap(input.flags, (flag) =>
			Option.match(Record.get(notes, flag.name), {
				onNone: () => [`--${flag.name}: no note`],
				onSome: (note) => noteFindings(operation, flag, note)
			})
		),
		...requestFindings(operation, section("REQUEST")),
		...authFindings(input, section("AUTH")),
		...responsesFindings(operation, section("RESPONSES")),
		...(Arr.contains(sectionsOf(input), "REFUSED")
			? refusedFindings(input, section("REFUSED"))
			: [])
	]
}

type Feature =
	| "a description"
	| "a summary alone"
	| "no prose"
	| "a description at the cap"
	| "a path argument"
	| "a negatable flag"
	| "a body field with choices"
	| "a body field with a default"
	| "a read-only body field"
	| "a deprecated flag"
	| "a part content type option"
	| "a required part header"
	| "positional parts"
	| "a discriminated body"
	| "a deprecated operation"
	| "an explicit empty security"
	| "absent security"
	| "an anonymous alternative"
	| "two schemes in one alternative"
	| "an author-supplied scheme"
	| "a deprecated scheme"
	| "an oauth2 scheme"
	| "an openIdConnect scheme"
	| "a mutualTLS certificate"
	| "a credential with a prompt"
	| "required scopes"
	| "roles"
	| "an undeclared scheme"
	| "a response header"
	| "a bracket-marked flag"
	| "a scalar-marked flag"
	| "a refused element"
	| "a refused field"
	| "another operation's refusal"
	| "hostile text"

const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> => (holds ? [feature] : [])

const hostile = regex("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]", "u")

const featuresOf = (input: HelpInput): ReadonlyArray<Feature> => {
	const { operation } = input
	const sources = Arr.map(input.flags, (flag) => flag.source)
	const fields = Arr.flatMap(sources, (source) =>
		source._tag === "Body" && source.field !== undefined ? [source.field] : []
	)
	const uses = Arr.flatMap(operation.security.alternatives, (alternative) => alternative.uses)
	const declared = (name: string) => Arr.findFirst(input.schemes, (scheme) => scheme.name === name)
	const usedSchemes = Arr.getSomes(Arr.map(uses, (use) => declared(use.scheme)))
	const refusals = Arr.filter(input.diagnostics, (diagnostic) => diagnostic.severity === "refusal")
	return [
		...when(operation.docs.description !== undefined, "a description"),
		...when(
			operation.docs.description === undefined && operation.docs.summary !== undefined,
			"a summary alone"
		),
		...when(
			operation.docs.description === undefined && operation.docs.summary === undefined,
			"no prose"
		),
		...when(
			Arr.fromIterable(operation.docs.description ?? "").length === MAX_PROSE,
			"a description at the cap"
		),
		...when(Arr.some(input.flags, isArgument), "a path argument"),
		...when(
			Arr.some(sources, (source) => source._tag === "Parameter" && source.negatable),
			"a negatable flag"
		),
		...when(
			Arr.some(fields, (field) => field.enum !== undefined),
			"a body field with choices"
		),
		...when(
			Arr.some(fields, (field) => Option.isSome(field.default)),
			"a body field with a default"
		),
		...when(
			Arr.some(fields, (field) => field.readOnly),
			"a read-only body field"
		),
		...when(Arr.some(sources, isDeprecated), "a deprecated flag"),
		...when(
			Arr.some(
				sources,
				(source) => source._tag === "PartOption" && source.option.kind === "content-type"
			),
			"a part content type option"
		),
		...when(
			Arr.some(
				sources,
				(source) =>
					source._tag === "PartOption" && source.option.kind === "header" && source.option.required
			),
			"a required part header"
		),
		...when(
			Arr.some(sources, (source) => source._tag === "Parts"),
			"positional parts"
		),
		...when(Arr.contains(sectionsOf(input), "VARIANTS"), "a discriminated body"),
		...when(operation.deprecated, "a deprecated operation"),
		...when(
			!Arr.isReadonlyArrayNonEmpty(operation.security.alternatives) && operation.security.declared,
			"an explicit empty security"
		),
		...when(
			!Arr.isReadonlyArrayNonEmpty(operation.security.alternatives) && !operation.security.declared,
			"absent security"
		),
		...when(
			Arr.some(
				operation.security.alternatives,
				(alternative) => !Arr.isReadonlyArrayNonEmpty(alternative.uses)
			),
			"an anonymous alternative"
		),
		...when(
			Arr.some(operation.security.alternatives, (alternative) => alternative.uses.length > 1),
			"two schemes in one alternative"
		),
		...when(
			Arr.some(usedSchemes, (scheme) => scheme.source === "author-supplied"),
			"an author-supplied scheme"
		),
		...when(
			Arr.some(usedSchemes, (scheme) => scheme.deprecated),
			"a deprecated scheme"
		),
		...when(
			Arr.some(usedSchemes, (scheme) => scheme.kind.type === "oauth2Token"),
			"an oauth2 scheme"
		),
		...when(
			Arr.some(usedSchemes, (scheme) => scheme.kind.type === "oidcToken"),
			"an openIdConnect scheme"
		),
		...when(
			Arr.some(uses, (use) =>
				Arr.some(input.certificates ?? [], (certificate) => certificate.scheme === use.scheme)
			),
			"a mutualTLS certificate"
		),
		...when(
			Arr.some(
				usedSchemes,
				(scheme) =>
					Arr.contains(scheme.credentialSources, "prompt") &&
					Arr.some(input.credentials, (credential) => credential.scheme === scheme.name)
			),
			"a credential with a prompt"
		),
		...when(
			Arr.some(
				uses,
				(use) =>
					Arr.isReadonlyArrayNonEmpty(use.scopes) &&
					Option.exists(
						declared(use.scheme),
						(scheme) => scheme.kind.type === "oauth2Token" || scheme.kind.type === "oidcToken"
					)
			),
			"required scopes"
		),
		...when(
			Arr.some(
				uses,
				(use) =>
					Arr.isReadonlyArrayNonEmpty(use.scopes) &&
					Option.exists(
						declared(use.scheme),
						(scheme) => scheme.kind.type !== "oauth2Token" && scheme.kind.type !== "oidcToken"
					)
			),
			"roles"
		),
		...when(
			Arr.some(uses, (use) => Option.isNone(declared(use.scheme))),
			"an undeclared scheme"
		),
		...when(Arr.contains(sectionsOf(input), "RESPONSE HEADERS"), "a response header"),
		...when(
			Arr.some(input.flags, (flag) =>
				Arr.contains(choicesOf(operation, flag), "deepObjectBrackets")
			),
			"a bracket-marked flag"
		),
		...when(
			Arr.some(input.flags, (flag) =>
				Arr.contains(choicesOf(operation, flag), "deepObjectScalars")
			),
			"a scalar-marked flag"
		),
		...when(
			Arr.some(
				input.diagnostics,
				(diagnostic) => isRefusedHere(operation)(diagnostic) && diagnostic.scope === "element"
			),
			"a refused element"
		),
		...when(
			Arr.some(
				input.diagnostics,
				(diagnostic) => isRefusedHere(operation)(diagnostic) && diagnostic.scope === "field"
			),
			"a refused field"
		),
		...when(
			Arr.some(refusals, (diagnostic) => diagnostic.operation?.path !== operation.key.path),
			"another operation's refusal"
		),
		...when(
			Arr.some(
				input.flags,
				(flag) => flag.source._tag === "Parameter" && hostile.test(flag.source.parameter.wireName)
			) || hostile.test(operation.operationId ?? ""),
			"hostile text"
		)
	]
}

const PROSE_CHARS: Arr.NonEmptyReadonlyArray<string> = [
	...TEXT_CHARS,
	"\udc00",
	"😀",
	"\u0000",
	"\u0085",
	"\u00ad",
	"\ufeff"
]

/** The code points sanitizing keeps: every one outside controls, format characters, separators and lone surrogates,
 * LF and TAB kept. */
const isKept = (char: string): boolean => char === "\n" || char === "\t" || !unsafe.test(char)

describe("emit: help", () => {
	it.effect(
		"help states exactly the facts of its operation, flags, schemes and refusals, each on one safe line",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "help",
						draw: drawn(helpInputGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a description",
								"a summary alone",
								"no prose",
								"a description at the cap",
								"a path argument",
								"a negatable flag",
								"a body field with choices",
								"a body field with a default",
								"a read-only body field",
								"a deprecated flag",
								"a part content type option",
								"a required part header",
								"positional parts",
								"a discriminated body",
								"a deprecated operation",
								"an explicit empty security",
								"absent security",
								"an anonymous alternative",
								"two schemes in one alternative",
								"an author-supplied scheme",
								"a deprecated scheme",
								"an oauth2 scheme",
								"an openIdConnect scheme",
								"a mutualTLS certificate",
								"a credential with a prompt",
								"required scopes",
								"roles",
								"an undeclared scheme",
								"a response header",
								"a bracket-marked flag",
								"a scalar-marked flag",
								"a refused element",
								"a refused field",
								"another operation's refusal",
								"hostile text"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: { kind: "bounded", candidates: 400 },
						concurrency: 1,
						steerEvery: 200,
						caseHang: Duration.seconds(10)
					},
					(input, k) =>
						Effect.sync(() => {
							const help = operationHelp(input)
							k.noteAll(featuresOf(input))
							const { operation } = input
							deepStrictEqual(
								{
									description: help.description,
									sections: Arr.map(help.sections, ([name]) => name),
									arguments: Arr.sort(Record.keys(help.arguments), Order.String),
									flags: Arr.sort(Record.keys(help.flags), Order.String),
									findings: helpFindings(input, help)
								},
								{
									description: sanitizeProse(
										operation.docs.description ?? operation.docs.summary ?? ""
									),
									sections: sectionsOf(input),
									arguments: Arr.sort(
										Arr.map(Arr.filter(input.flags, isArgument), (flag) => flag.name),
										Order.String
									),
									flags: Arr.sort(
										Arr.map(
											Arr.filter(input.flags, (flag) => !isArgument(flag)),
											(flag) => flag.name
										),
										Order.String
									),
									findings: []
								}
							)
						})
				)
			)
	)

	it.effect("sanitizing prose keeps exactly its safe code points, in order, up to the cap", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "sanitize prose",
					draw: drawn(
						weighted<string>([
							[6, string(characterOf(PROSE_CHARS), { min: 0, max: 30 })],
							[
								1,
								(s) =>
									Str.repeat(s.draw(int(1990, 2010)))(s.draw(element(["a", "中", "😀", "\u200e"])))
							]
						])
					),
					literal: Formatter.format,
					coverage: required<
						"a removed code point" | "past the cap" | "a kept line break" | "an astral character"
					>(["a removed code point", "past the cap", "a kept line break", "an astral character"], {
						cases: 500,
						sense: notesOnly
					}),
					kept: [],
					runs: 300,
					shrink: { kind: "bounded", candidates: 300 },
					concurrency: 1,
					steerEvery: 100,
					caseHang: Duration.seconds(10)
				},
				(prose, k) =>
					Effect.sync(() => {
						const points = Arr.fromIterable(prose)
						const kept = Arr.filter(points, isKept)
						k.noteAll([
							...(kept.length < points.length ? (["a removed code point"] as const) : []),
							...(kept.length > MAX_PROSE ? (["past the cap"] as const) : []),
							...(Arr.some(kept, (char) => char === "\n" || char === "\t")
								? (["a kept line break"] as const)
								: []),
							...(Arr.some(kept, (char) => char.length === 2)
								? (["an astral character"] as const)
								: [])
						])
						deepStrictEqual(sanitizeProse(prose), Arr.join(Arr.take(kept, MAX_PROSE), ""))
					})
			)
		)
	)
})
