import {
	Array as Arr,
	Effect,
	Option,
	pipe,
	Record,
	Result,
	String as Str,
	UndefinedOr
} from "effect"
import type { AuthorConfig } from "#model/author-config.ts"
import { isCookieName, isHeaderName, isWireName, stripUnsafeText } from "#model/brands.ts"
import type { DocumentUri, SafeText } from "#model/brands.ts"
import { makeDiagnostic } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { SecurityPolicy, SecurityScheme } from "#model/entities.ts"
import type { RowId } from "#model/entities.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import { childPointer, formatPointer, parsePointerResult, rootPointer } from "#model/pointer.ts"
import type { JsonPointer } from "#model/pointer.ts"
import { declaredOpenapi, specSectionUrl } from "#model/spec-section.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { follow, nodeOption } from "#normalize/document-set.ts"
import type { Resolution } from "#resolve/index.ts"
import { implicitComponent } from "#resolve/index.ts"
import * as Read from "#runtime/read.ts"

/**
 * The declared schemes of a document. `unusable` names schemes that were declared but refused, so
 * an alternative naming one is refused with it rather than treated as undeclared. `checkRefused`
 * holds the pointers of the requirement names check refused as unresolved. `added` names the
 * schemes `security.add` supplies that no declared scheme shares; only the author requirement
 * reaches them, so a spec requirement naming one stays undeclared (AS-1).
 */
export interface SchemeNormalization {
	readonly added: ReadonlySet<string>
	readonly checkRefused: ReadonlySet<string>
	readonly diagnostics: readonly Diagnostic[]
	readonly schemes: readonly SecurityScheme[]
	/**
	 * The author-supplied requirement (D-OQ3 (b)), carried here so every policy built from these
	 * schemes applies it where the spec declares no security.
	 */
	readonly supplied:
		| {
				readonly document: DocumentUri
				readonly requirement: readonly Requirement[]
		  }
		| undefined
	readonly unusable: readonly string[]
}

/**
 * An effective policy. `listed` is the number of alternatives the effective list held before any
 * were refused; a caller raises an operation only when `listed > 0` and none remain.
 */
export interface PolicyNormalization {
	readonly diagnostics: readonly Diagnostic[]
	readonly listed: number
	readonly policy: SecurityPolicy
}

interface Finding {
	readonly anchor: string
	readonly code: string
	/**
	 * The document the finding points into when it is not the spec (an author config finding).
	 */
	readonly document?: DocumentUri
	readonly element: string
	readonly hint?: string
	readonly message: string
	readonly pointer: string
	/**
	 * Each related site; one without a document points into the spec.
	 */
	readonly related?: readonly {
		readonly document?: DocumentUri
		readonly pointer: string
	}[]
	/**
	 * Element scope unless the finding refuses the whole document.
	 */
	readonly scope?: "document"
}

interface Built {
	readonly findings: readonly Finding[]
	readonly scheme?: SecurityScheme
}

/**
 * The members of a Security Scheme Object that normalize reads.
 */
interface SchemeFields {
	readonly deprecated: Option.Option<boolean>
	readonly flows: Option.Option<Read.Members>
	readonly in: Option.Option<string>
	readonly name: Option.Option<string>
	readonly oauth2MetadataUrl: Option.Option<string>
	readonly openIdConnectUrl: Option.Option<string>
	readonly scheme: Option.Option<string>
	readonly type: string
}

/**
 * A Security Scheme Object's members: refused when the node is no object, has no string `type` or holds a member of
 * another type than its own.
 */
const schemeFields: Read.Reader<SchemeFields> = Read.object(
	(node) => ({
		deprecated: Read.optionalMember(node, "deprecated", Read.boolean),
		flows: Read.optionalMember(node, "flows", Read.members),
		in: Read.optionalMember(node, "in", Read.string),
		name: Read.optionalMember(node, "name", Read.string),
		oauth2MetadataUrl: Read.optionalMember(node, "oauth2MetadataUrl", Read.string),
		openIdConnectUrl: Read.optionalMember(node, "openIdConnectUrl", Read.string),
		scheme: Read.optionalMember(node, "scheme", Read.string),
		type: Read.member(node, "type", Read.string)
	}),
	Read.anything
)

/**
 * An author-supplied scheme, which the author config has read already, as the members normalize reads. The config
 * admits no discovery URL, so it has none.
 */
const addedFields = (
	added: NonNullable<NonNullable<AuthorConfig["security"]>["add"]>["schemes"][string]
): SchemeFields => ({
	deprecated: Option.fromUndefinedOr(added.deprecated),
	flows: Option.fromUndefinedOr(added.flows),
	in: Option.fromUndefinedOr(added.in),
	name: Option.fromUndefinedOr(added.name),
	oauth2MetadataUrl: Option.none(),
	openIdConnectUrl: Option.none(),
	scheme: Option.fromUndefinedOr(added.scheme),
	type: added.type
})

/**
 * The members of an OAuth Flow Object that normalize reads.
 */
interface FlowFields {
	readonly authorizationUrl: Option.Option<string>
	readonly deviceAuthorizationUrl: Option.Option<string>
	readonly refreshUrl: Option.Option<string>
	readonly scopes: Option.Option<Readonly<Record<string, string>>>
	readonly tokenUrl: Option.Option<string>
}

/**
 * An OAuth Flow Object's members: refused when the node is no object or holds a member of another type than its own.
 */
const flowFields: Read.Reader<FlowFields> = Read.object(
	(node) => ({
		authorizationUrl: Read.optionalMember(node, "authorizationUrl", Read.string),
		deviceAuthorizationUrl: Read.optionalMember(node, "deviceAuthorizationUrl", Read.string),
		refreshUrl: Read.optionalMember(node, "refreshUrl", Read.string),
		scopes: Read.optionalMember(node, "scopes", Read.record(Read.string, Read.string)),
		tokenUrl: Read.optionalMember(node, "tokenUrl", Read.string)
	}),
	Read.anything
)

/**
 * A Security Requirement Object: each scheme name with its scopes.
 */
type Requirement = Readonly<Record<string, ReadonlyArray<string>>>

const requirementObject: Read.Reader<Requirement> = Read.record(
	Read.string,
	Read.array(Read.string)
)

/**
 * The OAuth flows normalize knows, each with the inventory row and specification anchor of its token acquisition and
 * whether that acquisition is refused for good.
 */
const flowRules = {
	authorizationCode: { anchor: "oauth-flows-authorization-code", permanent: false, row: "OAF-05" },
	clientCredentials: { anchor: "oauth-flows-client-credentials", permanent: false, row: "OAF-04" },
	deviceAuthorization: {
		anchor: "oauth-flows-device-authorization",
		permanent: false,
		row: "OAF-06"
	},
	implicit: { anchor: "oauth-flows-implicit", permanent: true, row: "OAF-02" },
	password: { anchor: "oauth-flows-password", permanent: true, row: "OAF-03" }
} as const

type FlowKind = keyof typeof flowRules

/**
 * Whether a flow name is one normalize knows.
 */
const isFlowKind = (name: string): name is FlowKind => Record.has<string, unknown>(flowRules, name)

const acquisitionHint = (permanent: boolean): string =>
	permanent
		? "This flow is permanently refused. Supply an access token obtained elsewhere."
		: "The generated CLI does not acquire tokens. Supply an access token obtained elsewhere."

const toDiagnostic = (resolution: Resolution, finding: Finding): Effect.Effect<Diagnostic> => {
	const openapi = Option.getOrElse(declaredOpenapi(resolution.value), () => "unknown")

	return makeDiagnostic({
		code: finding.code,
		document: finding.document ?? resolution.document,
		element: finding.element,
		hint: finding.hint,
		message: finding.message,
		openapi,
		pointer: finding.pointer,
		related: pipe(
			finding.related,
			UndefinedOr.map((sites) =>
				Arr.map(sites, (site) => ({
					document: site.document ?? resolution.document,
					pointer: site.pointer
				}))
			)
		),
		scope: finding.scope ?? "element",
		severity: "refusal",
		specSection: specSectionUrl(resolution.line, finding.anchor)
	})
}

const invalidScheme = (pointer: string): Built => ({
	findings: [
		{
			anchor: "security-scheme-type",
			code: "SSC-02/invalid-scheme",
			element: "Security Scheme Object",
			message: "The security scheme is malformed.",
			pointer
		}
	]
})

const acquisitionFindings = (fields: SchemeFields, pointer: string): readonly Finding[] => {
	if (fields.type === "openIdConnect") {
		return [
			{
				anchor: "security-scheme-open-id-connect-url",
				code: "SSC-19/token-acquisition",
				element: "Security Scheme Object",
				hint: acquisitionHint(false),
				message: "Token acquisition through OpenID Connect is refused.",
				pointer
			}
		]
	}

	if (fields.type !== "oauth2") {
		return []
	}

	return Option.match(fields.flows, {
		onNone: () => [],
		onSome: (flows) =>
			Arr.map(Arr.filter(Record.keys(flows), isFlowKind), (flow): Finding => {
				const rule = flowRules[flow]

				return {
					anchor: rule.anchor,
					code: `${rule.row}/token-acquisition`,
					element: "OAuth Flow Object",
					hint: acquisitionHint(rule.permanent),
					message: "Token acquisition through this OAuth flow is refused.",
					pointer: childPointer(childPointer(pointer, "flows"), flow)
				}
			})
	})
}

type SchemeKind = SecurityScheme["kind"]

type OAuthFlows = Extract<SchemeKind, { readonly type: "oauth2Token" }>["flows"]

type OAuthFlow = NonNullable<OAuthFlows[FlowKind]>

/**
 * A help-only URL of a flow under its member name, sanitized, when the spec gives it (design 9 I3); nothing when it
 * does not.
 */
const helpUrl = <
	K extends "authorizationUrl" | "deviceAuthorizationUrl" | "refreshUrl" | "tokenUrl"
>(
	key: K,
	url: Option.Option<string>
): { readonly [P in K]?: SafeText } =>
	Option.match(url, {
		onNone: () => ({}),
		onSome: (text) => Record.singleton(key, stripUnsafeText(text))
	})

/**
 * One flow's help-only data, sanitized. `deviceAuthorizationUrl` belongs to the 3.2 `deviceAuthorization` flow and is
 * read only there.
 */
const flowHelp = (kind: FlowKind, flow: FlowFields): OAuthFlow => ({
	...helpUrl("authorizationUrl", flow.authorizationUrl),
	...helpUrl(
		"deviceAuthorizationUrl",
		Option.filter(flow.deviceAuthorizationUrl, () => kind === "deviceAuthorization")
	),
	...helpUrl("refreshUrl", flow.refreshUrl),
	scopes: Option.match(flow.scopes, {
		onNone: () => [],
		onSome: (scopes) =>
			Arr.map(Record.toEntries(scopes), ([name, description]) => ({
				description: stripUnsafeText(description),
				name: stripUnsafeText(name)
			}))
	}),
	...helpUrl("tokenUrl", flow.tokenUrl)
})

/**
 * The help-only flows of an `oauth2` node by flow kind, in the order of `flowRules`, or none when a known flow is
 * malformed. Unknown flow names carry nothing a help line needs and are skipped.
 */
const flowsOf = (flows: Read.Members): Option.Option<OAuthFlows> =>
	Option.map(
		Option.all(
			Arr.flatMap(Record.keys(flowRules), (kind) =>
				Option.toArray(
					Option.map(Record.get(flows, kind), (json) =>
						Option.map(
							Result.getSuccess(flowFields(json)),
							(flow) => [kind, flowHelp(kind, flow)] as const
						)
					)
				)
			)
		),
		(known) => Record.fromEntries(known)
	)

/**
 * A scheme node modelled: its kind and the inventory row of that kind.
 */
interface Modelled {
	readonly kind: SchemeKind
	readonly row: RowId
}

/**
 * What a scheme node models as: its kind, or the findings that refuse it.
 */
type Modelling = Result.Result<Modelled, readonly Finding[]>

/**
 * The refusal of a scheme node that is not a scheme normalize can model.
 */
const malformed = (pointer: string): Modelling => Result.fail(invalidScheme(pointer).findings)

/**
 * The `apiKey` locations normalize sends, each modelling a scheme's name there: a cookie or header name must be a
 * token, refused with its own finding when it is not, and a query name a wire name.
 */
const apiKeyLocations = {
	cookie: (name: string, pointer: string): Modelling =>
		isCookieName(name)
			? Result.succeed({ kind: { in: "cookie", name, type: "apiKey" }, row: "SSC-14" })
			: Result.fail([
					{
						anchor: "security-scheme-name",
						code: "SSC-14/invalid-cookie-name",
						element: "Security Scheme Object",
						hint: 'A cookie name must be an RFC 6265 token: no space, control, or any of ()<>@,;:\\"/[]?={}.',
						message: "The cookie apiKey name is not a valid cookie name.",
						pointer
					}
				]),
	header: (name: string, pointer: string): Modelling =>
		isHeaderName(name)
			? Result.succeed({ kind: { in: "header", name, type: "apiKey" }, row: "SSC-12" })
			: Result.fail([
					{
						anchor: "security-scheme-name",
						code: "SSC-12/invalid-header-name",
						element: "Security Scheme Object",
						hint: 'A header name must be an RFC 9110 token: no space, control, non-ASCII, or any of ()<>@,;:\\"/[]?={}.',
						message: "The header apiKey name is not a valid header name.",
						pointer
					}
				]),
	query: (name: string, pointer: string): Modelling =>
		isWireName(name)
			? Result.succeed({ kind: { in: "query", name, type: "apiKey" }, row: "SSC-13" })
			: malformed(pointer)
} as const

type ApiKeyLocation = keyof typeof apiKeyLocations

const isApiKeyLocation = (location: string): location is ApiKeyLocation =>
	Record.has<string, unknown>(apiKeyLocations, location)

/**
 * The `http` schemes normalize sends, case-insensitively, each with its inventory row.
 */
const httpRows = { basic: "SSC-15", bearer: "SSC-16" } as const

type HttpScheme = keyof typeof httpRows

const isHttpScheme = (scheme: string): scheme is HttpScheme =>
	Record.has<string, unknown>(httpRows, scheme)

/**
 * An `http` scheme: basic or bearer; any other is refused as unsupported.
 */
const httpOf = (fields: SchemeFields, pointer: string): Modelling =>
	Option.match(Option.filter(Option.map(fields.scheme, Str.toLowerCase), isHttpScheme), {
		onNone: () =>
			Result.fail([
				{
					anchor: "security-scheme-scheme",
					code: "SSC-17/unsupported-scheme",
					element: "Security Scheme Object",
					hint: "Only the basic and bearer http schemes are supported.",
					message: "The http authentication scheme is not supported.",
					pointer
				}
			]),
		onSome: (scheme) => Result.succeed({ kind: { scheme, type: "http" }, row: httpRows[scheme] })
	})

/**
 * The modelled kind and inventory row of a scheme node, or the findings that refuse it: malformed when the type is
 * unknown, an `apiKey` has no name or another location, an `oauth2` flow is malformed or an `openIdConnect` scheme has
 * no discovery URL. `oauth2MetadataUrl` is a 3.2 field and is recorded only on 3.2.
 */
const kindOf = (fields: SchemeFields, line: SpecLine, pointer: string): Modelling => {
	if (fields.type === "apiKey") {
		return Option.match(
			Option.all({ location: Option.filter(fields.in, isApiKeyLocation), name: fields.name }),
			{
				onNone: () => malformed(pointer),
				onSome: ({ location, name }) => apiKeyLocations[location](name, pointer)
			}
		)
	}

	if (fields.type === "http") {
		return httpOf(fields, pointer)
	}

	if (fields.type === "mutualTLS") {
		return Result.succeed({ kind: { type: "mutualTls" }, row: "SSC-20" })
	}

	if (fields.type === "oauth2") {
		const metadata = Option.match(
			Option.filter(fields.oauth2MetadataUrl, () => line === "3.2"),
			{
				onNone: () => ({}),
				onSome: (url) => ({ oauth2MetadataUrl: stripUnsafeText(url) })
			}
		)

		return Option.match(flowsOf(Option.getOrElse(fields.flows, Record.empty)), {
			onNone: () => malformed(pointer),
			onSome: (flows) =>
				Result.succeed({ kind: { flows, ...metadata, type: "oauth2Token" }, row: "SSC-18" })
		})
	}

	return Option.match(
		Option.filter(fields.openIdConnectUrl, () => fields.type === "openIdConnect"),
		{
			onNone: () => malformed(pointer),
			onSome: (url) =>
				Result.succeed({
					kind: { openIdConnectUrl: stripUnsafeText(url), type: "oidcToken" },
					row: "SSC-19"
				})
		}
	)
}

/**
 * Where a scheme is declared: its pointer, the document that holds it, the OAS line of the spec it
 * serves and whether the spec or the author config declares it. A finding about an author-supplied
 * scheme points into the config.
 */
interface Site {
	readonly document: DocumentUri
	readonly line: SpecLine
	readonly pointer: JsonPointer
	readonly source: SecurityScheme["source"]
}

/**
 * A scheme modelled from its node's members; a scheme with an empty name is malformed.
 */
const modelFields = (name: string, site: Site, node: SchemeFields): Built => {
	const { pointer } = site

	return Result.match(kindOf(node, site.line, pointer), {
		onFailure: (findings): Built => ({ findings }),
		onSuccess: (modelled) =>
			Str.isEmpty(name)
				? invalidScheme(pointer)
				: {
						findings: acquisitionFindings(node, pointer),
						scheme: {
							credentialSources: node.type === "mutualTLS" ? ["env"] : ["file", "env", "prompt"],
							deprecated: Option.getOrElse(node.deprecated, () => false),
							kind: modelled.kind,
							name,
							origin: { document: site.document, pointer },
							rows: ["SSC-01", modelled.row],
							source: site.source
						}
					}
	})
}

/**
 * Models one scheme node. An author-supplied scheme is judged by the same rules as a declared one;
 * only the document its findings and origin name differs.
 */
const modelScheme = (name: string, site: Site, fields: SchemeFields): Built => {
	const built = modelFields(name, site, fields)

	return site.source === "spec"
		? built
		: {
				...built,
				findings: Arr.map(built.findings, (finding) => ({ ...finding, document: site.document }))
			}
}

const buildScheme = (resolution: Resolution, name: string, pointer: JsonPointer): Built => {
	const target = follow(resolution, { document: resolution.document, pointer })
	const read = Option.flatMap(nodeOption(resolution, target), (json) =>
		Result.getSuccess(schemeFields(json))
	)

	return Option.match(read, {
		onNone: () => invalidScheme(pointer),
		onSome: (fields) =>
			modelScheme(
				name,
				{ document: resolution.document, line: resolution.line, pointer, source: "spec" },
				fields
			)
	})
}

/**
 * What author-supplied security needs: the author config and the document it was read from
 * (D-OQ3 (b)).
 */
export interface AuthorConfigSource {
	readonly config: AuthorConfig
	readonly configDocument: DocumentUri
}

const addRequirementPointer = formatPointer(["security", "add", "requirement"])

const collision = (author: AuthorConfigSource, name: string): Finding => ({
	anchor: "security-scheme-object",
	code: "CFG-1/scheme-name-collision",
	document: author.configDocument,
	element: "Author config",
	hint: "Rename the added scheme; the spec already declares a security scheme with this name.",
	message: "An added security scheme has the name of a declared one.",
	pointer: formatPointer(["security", "add", "schemes", name]),
	scope: "document"
})

interface Added {
	readonly built: readonly Built[]
	readonly names: readonly string[]
}

/**
 * The schemes `security.add` contributes, in config order. A collision with a declared name is a
 * document-scope refusal and the added scheme is dropped.
 */
const addedSchemes = (
	declared: ReadonlySet<string>,
	author: AuthorConfigSource | undefined,
	line: SpecLine
): Added => {
	const entries = Record.toEntries(author?.config.security?.add?.schemes ?? {})
	const built = Arr.map(entries, ([name, node]): Built => {
		if (author === undefined) {
			return { findings: [] }
		}

		return declared.has(name)
			? { findings: [collision(author, name)] }
			: modelScheme(
					name,
					{
						document: author.configDocument,
						line,
						pointer: formatPointer(["security", "add", "schemes", name]),
						source: "author-supplied"
					},
					addedFields(node)
				)
	})

	return { built, names: Arr.map(entries, ([name]) => name) }
}

/**
 * The codes check raises at a requirement name that reaches no scheme (src/check/grammar.ts).
 */
const unresolvedCodes: ReadonlySet<string> = new Set([
	"SEC-09/unresolved-scheme",
	"SEC-10/unresolved-scheme"
])

/**
 * Normalizes `components.securitySchemes` into scheme entities (design 6.5). A scheme that cannot
 * be modelled is refused at element scope and listed in `unusable`. An `oauth2` or `openIdConnect`
 * scheme stays usable through an operator-supplied token, with its flows, scopes and discovery URL
 * recorded for help only; its token acquisition is refused at element scope (D-SEC1), and a scheme
 * whose every flow is refused stays usable (design 10.4). With
 * `author`, the schemes of `security.add` follow the declared ones, marked `author-supplied`; a
 * name that is also declared is refused at document scope and the declared scheme stays.
 * `checkFindings` are the spec-text check findings of the run; a requirement name they refuse as
 * unresolved gets no second diagnostic from `normalizeSecurityPolicy`.
 */
export const normalizeSecuritySchemes = Effect.fnUntraced(function* normalizeSecuritySchemes(
	resolution: Resolution,
	author: AuthorConfigSource | undefined,
	checkFindings: readonly Diagnostic[]
): Effect.fn.Return<SchemeNormalization> {
	const schemes = { document: resolution.document, pointer: "/components/securitySchemes" }
	const names = nodeOption(resolution, schemes).pipe(
		Option.filter(isObject),
		Option.match({ onNone: (): string[] => [], onSome: (map) => Record.keys(map) })
	)
	const refused = new Set<string>(
		Arr.map(
			Arr.filter(
				resolution.diagnostics,
				(diagnostic) => diagnostic.code === "SEC-10/uri-like-name"
			),
			(diagnostic) => diagnostic.pointer
		)
	)
	const built = Arr.map(names, (name): Built => {
		const pointer = formatPointer(["components", "securitySchemes", name])

		return refused.has(pointer) ? { findings: [] } : buildScheme(resolution, name, pointer)
	})
	const extra = addedSchemes(new Set(names), author, resolution.line)
	const all = [...built, ...extra.built]
	const diagnostics = yield* Effect.forEach(
		Arr.flatMap(all, (one) => one.findings),
		(finding) => toDiagnostic(resolution, finding)
	)

	const requirement = author?.config.security?.add?.requirement
	const supplied =
		author === undefined || requirement === undefined
			? undefined
			: { document: author.configDocument, requirement }

	return {
		added: new Set(Arr.difference(extra.names, names)),
		checkRefused: new Set(
			Arr.map(
				Arr.filter(
					checkFindings,
					(finding) => finding.document === resolution.document && unresolvedCodes.has(finding.code)
				),
				(finding) => finding.pointer
			)
		),
		diagnostics,
		schemes: Arr.getSomes(Arr.map(all, (one) => Option.fromUndefinedOr(one.scheme))),
		supplied,
		unusable: [
			...Arr.filter(names, (_, index) => built[index]?.scheme === undefined),
			...Arr.filter(
				extra.names,
				(name, index) => !names.includes(name) && extra.built[index]?.scheme === undefined
			)
		]
	}
})

interface Scope {
	readonly declared: ReadonlyMap<string, SecurityScheme>
	readonly unusable: ReadonlySet<string>
}

/**
 * The author requirement reaches every scheme; a spec requirement reaches only the spec's (AS-1).
 */
interface Lookup {
	readonly author: Scope
	readonly spec: Scope
}

/**
 * Built once per policy, so a requirement entry costs one map probe.
 */
const lookupOf = (schemes: SchemeNormalization): Lookup => ({
	author: {
		declared: new Map(Arr.map(schemes.schemes, (scheme) => [scheme.name, scheme])),
		unusable: new Set(schemes.unusable)
	},
	spec: {
		declared: new Map(
			Arr.map(
				Arr.filter(schemes.schemes, (scheme) => scheme.source === "spec"),
				(scheme) => [scheme.name, scheme]
			)
		),
		unusable: new Set(Arr.filter(schemes.unusable, (name) => !schemes.added.has(name)))
	}
})

/**
 * A 3.2 requirement name that is not a component name resolves as a URI inside the set. The result
 * is the component name it reaches, or undefined when it reaches nothing that is a component.
 */
const uriComponentName = (resolution: Resolution, name: string): string | undefined => {
	if (resolution.line !== "3.2") {
		return undefined
	}

	const key = implicitComponent(resolution, "securitySchemes", name)
	if (Option.isNone(key)) {
		return undefined
	}

	const tokens = Result.getOrUndefined(parsePointerResult(key.value.pointer))

	return tokens?.length === 3 && tokens[0] === "components" && tokens[1] === "securitySchemes"
		? tokens[2]
		: undefined
}

interface Source {
	readonly pointer: JsonPointer
	readonly rows: ReadonlyArray<RowId>
}

/**
 * Operation `security` replaces the root list; with neither the policy is undeclared (design 6.5). `operation` holds
 * the reference tokens of the operation object. Each listed alternative is its Security Requirement Object, or none
 * when it is malformed.
 */
const effectiveList = (
	resolution: Resolution,
	operation: Option.Option<ReadonlyArray<string>>
):
	| { readonly list: readonly Option.Option<Requirement>[]; readonly source: Source }
	| undefined => {
	const candidates: readonly Source[] = [
		...Option.toArray(
			Option.map(operation, (tokens): Source => ({
				pointer: formatPointer([...tokens, "security"]),
				rows: ["SEC-01", "SEC-04"]
			}))
		),
		{ pointer: formatPointer(["security"]), rows: ["SEC-01", "SEC-03"] }
	]
	for (const source of candidates) {
		const list = nodeOption(resolution, {
			document: resolution.document,
			pointer: source.pointer
		}).pipe(Option.filter(isArray))
		if (Option.isSome(list)) {
			return {
				list: Arr.map(list.value, (json) => Result.getSuccess(requirementObject(json))),
				source
			}
		}
	}

	return undefined
}

interface Judged {
	readonly findings: readonly Finding[]
	readonly use?: readonly { readonly scheme: string; readonly scopes: readonly string[] }[]
}

interface Named {
	readonly checkRefused: ReadonlySet<string>
	readonly name: string
	readonly pointer: string
	readonly resolved: string
	/**
	 * The entries come from the author config, which check never reads.
	 */
	readonly supplied: boolean
	readonly unusable: ReadonlySet<string>
}

/**
 * The refusal of a requirement name that names no usable scheme, or None when check already raised
 * the one diagnostic for it; either way its alternative is dropped.
 */
const nameRefusal = (resolution: Resolution, named: Named): Option.Option<Finding> => {
	const { name, resolved } = named
	const pointer = childPointer(named.pointer, name)
	if (named.unusable.has(resolved)) {
		return Option.some({
			anchor: "security-requirements-name",
			code: "SEC-02/unusable-scheme",
			element: "Security Requirement Object",
			message: "The requirement names a security scheme that is refused.",
			pointer,
			related: [{ pointer: formatPointer(["components", "securitySchemes", resolved]) }]
		})
	}

	if (!named.supplied && named.checkRefused.has(pointer)) {
		return Option.none()
	}

	return Option.some({
		anchor: "security-requirements-name",
		code: `${resolution.line === "3.2" ? "SEC-10" : "SEC-09"}/undeclared-scheme`,
		element: "Security Requirement Object",
		message: "The requirement names a security scheme that is not declared.",
		pointer
	})
}

/**
 * Whether a scheme writes the one `Authorization` header (design 6.5 Conflicting Authorization
 * schemes): http basic or bearer, oauth2, openIdConnect, or an apiKey header named Authorization.
 */
const setsAuthorization = ({ kind }: SecurityScheme): boolean => {
	if (kind.type === "apiKey") {
		return kind.in === "header" && Str.toLowerCase(kind.name) === "authorization"
	}

	return kind.type === "http" || kind.type === "oauth2Token" || kind.type === "oidcToken"
}

/**
 * The refusal of an alternative whose schemes write the `Authorization` header more than once, so
 * that every scheme cannot be satisfied (SEC-05); undefined when at most one writes it.
 */
const conflictRefusal = (
	schemes: ReadonlyMap<string, SecurityScheme>,
	pointer: string
): Finding | undefined => {
	const writers = Arr.filter([...schemes.values()], setsAuthorization)

	return writers.length < 2
		? undefined
		: {
				anchor: "security-requirement-object",
				code: "SEC-01/conflicting-authorization",
				element: "Security Requirement Object",
				hint: "Each of these schemes sets the Authorization header, so one request cannot carry both. Use another alternative.",
				message: "The alternative requires two schemes that both set the Authorization header.",
				pointer,
				related: Arr.map(writers, (scheme) => ({
					document: scheme.origin.document,
					pointer: scheme.origin.pointer
				}))
			}
}

/**
 * `supplied`: the entries come from the author config, so they alone reach the added schemes and
 * normalize reports their undeclared names itself.
 */
const judge = (
	resolution: Resolution,
	schemes: SchemeNormalization,
	lookup: Lookup,
	entries: readonly (readonly [string, readonly string[]])[],
	pointer: string,
	supplied: boolean
): Judged => {
	const findings: Finding[] = []
	let refused = false
	const { declared: byName, unusable } = supplied ? lookup.author : lookup.spec
	const used: { readonly scheme: string; readonly scopes: readonly string[] }[] = []
	const reached = new Map<string, SecurityScheme>()
	for (const [name, scopes] of entries) {
		const exact = byName.has(name) || unusable.has(name)
		const resolved = exact ? name : (uriComponentName(resolution, name) ?? name)
		const declared = byName.get(resolved)
		if (declared !== undefined) {
			used.push({ scheme: resolved, scopes })
			reached.set(resolved, declared)
		}

		if (declared === undefined) {
			const refusal = nameRefusal(resolution, {
				checkRefused: schemes.checkRefused,
				name,
				pointer,
				resolved,
				supplied,
				unusable
			})
			if (Option.isNone(refusal)) {
				refused = true
			} else {
				findings.push(refusal.value)
			}
		}
	}

	const conflict = conflictRefusal(reached, pointer)
	if (conflict !== undefined) {
		findings.push(conflict)
	}

	return findings.length > 0 || refused ? { findings } : { findings, use: used }
}

/**
 * Normalizes the effective security policy of an operation, or of the root when `operation` is
 * omitted (design 6.5). `operation` holds the reference tokens of the operation object. An alternative that
 * names an undeclared or refused scheme, or two schemes that each set the `Authorization` header
 * (`SEC-01/conflicting-authorization`), is removed whole with element-scope refusals and never
 * dropped silently. A `mutualTLS` scheme is usable like any other (design 6.5, D-SEC3). A spec name
 * check already refused as unresolved keeps that one diagnostic and gets no second here. Raising an
 * operation with no alternative left is the caller's job (`listed`).
 */
export const normalizeSecurityPolicy = Effect.fnUntraced(function* normalizeSecurityPolicy(
	resolution: Resolution,
	schemes: SchemeNormalization,
	operation: Option.Option<ReadonlyArray<string>>
): Effect.fn.Return<PolicyNormalization> {
	const spec = effectiveList(resolution, operation)
	const lookup = lookupOf(schemes)
	/**
	 * `security.add` applies as if declared, only where the spec declares no security (D-OQ10).
	 */
	const supplied =
		spec === undefined && schemes.supplied !== undefined
			? {
					document: schemes.supplied.document,
					list: Arr.map(schemes.supplied.requirement, (requirement) => Option.some(requirement)),
					source: {
						pointer: addRequirementPointer,
						rows: ["CFG-1", "SEC-01", "SEC-08"]
					} satisfies Source
				}
			: undefined
	const effective =
		supplied ??
		pipe(
			spec,
			UndefinedOr.map((declared) => ({ ...declared, document: resolution.document }))
		)
	const source: Source = effective?.source ?? {
		pointer: Option.match(operation, {
			onNone: () => rootPointer,
			onSome: (tokens) => formatPointer(tokens)
		}),
		rows: ["SEC-08"]
	}
	const judged = Arr.map(effective?.list ?? [], (requirement, index) => {
		const pointer = childPointer(source.pointer, String(index))

		return Option.match(requirement, {
			onNone: (): Judged => ({
				findings: [
					{
						anchor: "security-requirement-object",
						code: "SEC-01/invalid-requirement",
						element: "Security Requirement Object",
						message: "The security requirement is malformed.",
						pointer
					}
				]
			}),
			onSome: (read) =>
				judge(resolution, schemes, lookup, Record.toEntries(read), pointer, supplied !== undefined)
		})
	})
	const diagnostics = yield* Effect.forEach(
		Arr.flatMap(judged, (one) => one.findings),
		(finding) =>
			toDiagnostic(
				resolution,
				supplied === undefined ? finding : { ...finding, document: supplied.document }
			)
	)
	const policy: SecurityPolicy = {
		alternatives: Arr.getSomes(
			Arr.map(judged, (one) => Option.map(Option.fromUndefinedOr(one.use), (uses) => ({ uses })))
		),
		declared: effective !== undefined,
		origin: { document: effective?.document ?? resolution.document, pointer: source.pointer },
		rows: source.rows
	}

	return { diagnostics, listed: judged.length, policy }
})
