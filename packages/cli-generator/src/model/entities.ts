import { regex } from "arkregex"
import type { Array as Arr } from "effect"
import type {
	CookieName,
	DocumentUri,
	HeaderName,
	MediaRange,
	MediaType,
	MethodToken,
	PathTemplate,
	SafeText,
	ServerTemplate,
	WireName
} from "#model/brands.ts"
import type { Json, JsonPointer } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"

/**
 * An inventory row id such as `PRM-27`: an uppercase prefix that may hold digits, a hyphen, a number. Every row the
 * generator records is a literal of its own code, which this type checks where it is written.
 */
export type RowId = `${Uppercase<string>}-${number}`

const rowIdPattern = regex("^[A-Z][A-Z0-9]*-[0-9]+$", "u")

/** Whether text is a row id: the one reading of a row out of text, such as a diagnostic code's prefix. */
export const isRowId = (text: string): text is RowId => rowIdPattern.test(text)

/** Where an entity came from: a document of the set and the RFC 6901 pointer of its use site. */
export type Origin = Readonly<{ document: DocumentUri; pointer: JsonPointer }>

/** Help text for an element: the document gives either, both or neither. */
export type Docs = Readonly<{ description?: SafeText; summary?: SafeText }>

/** A reference into the one `SchemaStore` by its `$defs` key. */
export type SchemaRef = Readonly<{ key: string }>

type Rows = ReadonlyArray<RowId>

/** The eight serialization styles a Parameter, Header or Encoding Object may declare. */
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

/** One of the {@link styleNames}. */
export type StyleName = (typeof styleNames)[number]

/**
 * The non-standard serializations the author config opted into for one entry (design 6.1, D-OQ1 (b)), one marker
 * per switch: `nonStandard` (`deepObjectBrackets`) sends a `deepObject` value's nested members in the bracket
 * convention; `nonStandardScalars` (`deepObjectScalars`) sends a scalar `deepObject` value as `name=value`. Set only
 * from the author config, never defaulted or inferred; absent is strict.
 */
type NonStandard = Readonly<{
	nonStandard?: "deepObjectBrackets"
	nonStandardScalars?: "deepObjectScalars"
}>

/**
 * A response Header Object by name, with its `required` and `deprecated` marks (HDR-03, HDR-04); absent in the
 * document, each is false.
 */
type ResponseHeader = Readonly<{ deprecated: boolean; name: HeaderName; required: boolean }>

/**
 * A parameter written in `style` form. `objectValued` says the schema, through `$ref`, admits only objects (design
 * 6.1): the operator gives the value as JSON, which the runtime expands by its style.
 */
export type StyleSerialization = NonStandard &
	Readonly<{
		allowReserved: boolean
		explode: boolean
		kind: "style"
		objectValued: boolean
		origin: Origin
		rows: Rows
		rules: string
		style: StyleName
	}>

/**
 * A parameter written in `content` form. `encoding` holds the rules of a 3.2 `querystring` parameter's
 * form-urlencoded content, one per declared property in document order, decided as a form body alternative's are
 * (design 6.1, 6.3); it is empty for any other content.
 */
export type ContentSerialization = Readonly<{
	encoding: ReadonlyArray<EncodingRule>
	kind: "content"
	mediaType: MediaType
	origin: Origin
	rows: Rows
	rules: string
	schema: SchemaRef
}>

/** How a parameter value reaches the wire: by style or by content. */
export type Serialization = StyleSerialization | ContentSerialization

/**
 * A part header of an Encoding Object: a Header Object by name, typed and serialized as a header parameter is
 * (HDR-01, ENC-03), with its `required` and `deprecated` marks and, when the Header Object or its schema carries
 * `x-sensitive: true`, `sensitive`.
 */
type PartHeader = Readonly<{
	deprecated: boolean
	name: HeaderName
	required: boolean
	schema: SchemaRef
	sensitive?: true
	serialization: Serialization
}>

/** What an encoding rule applies to: a property by name, or a position of an array body. */
type EncodingTarget =
	| Readonly<{ kind: "property"; name: WireName }>
	| Readonly<{ index: number; kind: "position" }>

/** The style keys an Encoding Object states, each only where it states it. */
type ExplicitStyle = Readonly<{ allowReserved?: boolean; explode?: boolean; style?: StyleName }>

/** A rule of a part's one nested level (design 6.3, HT:B16). */
type NestedEncodingRule = Readonly<{
	contentType: ReadonlyArray<MediaRange>
	headers: ReadonlyArray<PartHeader>
	serialization?: ExplicitStyle
	target: EncodingTarget
}>

/**
 * A per-property or per-position encoding rule of a media alternative (design 2.2). `contentEncoding` is the part's
 * transfer encoding: base64, the one the runtime supports, from 3.0 `format: byte` (ENC-38) or 3.1+
 * `contentEncoding` (ENC-37); absent, the part is sent as is. `nested` holds the one nested level's rules, by name
 * and by position, and is present whenever the part nests; `nestedItem` is the nested `itemEncoding`, the rule of
 * every nested position after the nested `prefixEncoding` (ENC-09).
 */
export type EncodingRule = NonStandard &
	Readonly<{
		contentEncoding?: "base64"
		contentType: ReadonlyArray<MediaRange>
		headers: ReadonlyArray<PartHeader>
		nested?: ReadonlyArray<NestedEncodingRule>
		nestedItem?: NestedEncodingRule
		origin: Origin
		rows: Rows
		serialization?: ExplicitStyle
		target: EncodingTarget
	}>

/**
 * One branch of a discriminated body: its composition `index`, the entry component it names when its `$ref` chain
 * ends at one, and the discriminator values that select it, in mapping order.
 */
type DiscriminatorBranch = Readonly<{
	component?: string
	index: number
	labels: ReadonlyArray<string>
}>

/**
 * The usable discriminator of a request body's root schema, a hint that never changes validation (design D-OQ9,
 * DSC-06). `keyword` is the composition its branches come from; for `allOf`, the branches are the entry components
 * whose own `allOf` references the schema (DSC-11).
 */
export type DiscriminatorHint = Readonly<{
	branches: ReadonlyArray<DiscriminatorBranch>
	keyword: "allOf" | "anyOf" | "oneOf"
	propertyName: string
}>

/**
 * How JSON event data reads: `json`, one JSON text, printed compacted; or `{ json }`, one JSON text its
 * `contentSchema` checks before it prints, the schema named by its store key, so the CLI fails on data the schema
 * refuses rather than printing it.
 */
type JsonData = "json" | Readonly<{ json: string }>

/** How an event's data reads: `text`, printed as a JSON string, for data whose `contentMediaType` is not JSON; else JSON. */
export type EventData = "text" | JsonData

/**
 * Where a failure event's JSON data says that retrying is safe: the JSON Pointer into the data and the scalar it holds
 * there when it is.
 */
export type RetryWhen = Readonly<{ equals: string | number | boolean; pointer: JsonPointer }>

/**
 * One event type of an SSE response's item union (`x-stream`, design of the event lifecycle): its name, how its data
 * prints and its role. An `item` is printed and the stream goes on; `ready` ends the initial state, the default stop;
 * a `ready` with a `next` is followed by that one event alone, so the stream has no live part to follow; `end` ends
 * the stream; `error` ends it with a failure, retried only when its JSON data holds `retryWhen`'s value.
 */
export type StreamEvent =
	| Readonly<{ data: JsonData; name: string; retryWhen: RetryWhen; role: "error" }>
	| Readonly<{ data: EventData; name: string; next: string; role: "ready" }>
	| Readonly<{ data: EventData; name: string; role: "end" | "error" | "item" | "ready" }>

/**
 * What an event of a type the contract does not name is: a violation of a `Closed` contract, whose union names every
 * event it admits, or an item of an `Open` one, its data printed as `data` says.
 */
type EventOtherwise =
	| Readonly<{ _tag: "Closed" }>
	| Readonly<{ _tag: "Open"; data: "json" | "text" }>

/**
 * The event contract of a `text/event-stream` response alternative, read from its `itemSchema`: each event type its
 * union names, each name once, and what an event of any other type is.
 */
export type EventContract = Readonly<{
	events: ReadonlyArray<StreamEvent>
	otherwise: EventOtherwise
}>

/** How a media alternative's bytes are read and written, derived from its media type. */
export type Codec =
	| "binary"
	| "form"
	| "json"
	| "jsonseq"
	| "multipart"
	| "ndjson"
	| "sse"
	| "text"
	| "xml"

/**
 * One media type a body or response offers; `codec` is derived from the media type. `discriminator` and
 * `refusedFields` are set on a request body alternative only; `events`, on a `text/event-stream` response alternative
 * whose `itemSchema` names events or JSON data only. `refusedFields` names the alternative's properties refused at
 * `field` scope, in property order (design 8.5); absent, none is refused.
 */
export type MediaAlternative = Readonly<{
	codec: Codec
	discriminator?: DiscriminatorHint
	encoding: ReadonlyArray<EncodingRule>
	events?: EventContract
	itemEncoding?: EncodingRule
	itemSchema?: SchemaRef
	mediaType: MediaType | MediaRange
	origin: Origin
	prefixEncoding: ReadonlyArray<EncodingRule>
	refusedFields?: ReadonlyArray<WireName>
	rows: Rows
	schema?: SchemaRef
}>

/** A request body; alternatives keep document order. */
export type Body = Readonly<{
	alternatives: ReadonlyArray<MediaAlternative>
	docs: Docs
	origin: Origin
	required: boolean
	rows: Rows
}>

/**
 * An operation parameter after path-item merge. `sensitive` is present when the Parameter Object or its schema
 * carries `x-sensitive: true`; output redacts such a header's value (`format: password` is read from its schema, not
 * here).
 */
export type Parameter = Readonly<{
	deprecated: boolean
	docs: Docs
	location: "cookie" | "header" | "path" | "query" | "querystring"
	origin: Origin
	required: boolean
	rows: Rows
	schema: SchemaRef
	sensitive?: true
	serialization: Serialization
	wireName: WireName
}>

/**
 * The key of a response: a status code (100 to 599), a status class by its digit (1 to 5, `2XX` as 2), or `default`.
 */
export type ResponseKey = Readonly<{ code: number }> | Readonly<{ range: number }> | "default"

/** One status code, status range or `default` response. */
export type ResponseCase = Readonly<{
	alternatives: ReadonlyArray<MediaAlternative>
	docs: Docs
	headers: ReadonlyArray<ResponseHeader>
	key: ResponseKey
	origin: Origin
	rows: Rows
}>

/** A server, at root, path item or operation level; `accepted` comes only from the author config. */
export type Server = Readonly<{
	accepted: boolean
	level: "operation" | "pathItem" | "root"
	name?: SafeText
	origin: Origin
	origins: ReadonlyArray<DocumentUri>
	rows: Rows
	template: ServerTemplate
	variables: ReadonlyArray<
		Readonly<{ default: string; enum?: ReadonlyArray<string>; name: string }>
	>
}>

/**
 * One OAuth flow as help text: its URLs when the spec gives them and its scopes by name. No URL here ever becomes a
 * request target (design 9 I3).
 */
type OAuthFlow = Readonly<{
	authorizationUrl?: SafeText
	deviceAuthorizationUrl?: SafeText
	refreshUrl?: SafeText
	scopes: ReadonlyArray<Readonly<{ description: SafeText; name: SafeText }>>
	tokenUrl?: SafeText
}>

/** The flows of an `oauth2` scheme by flow kind, recorded for help only. */
type OAuthFlows = Readonly<{
	authorizationCode?: OAuthFlow
	clientCredentials?: OAuthFlow
	deviceAuthorization?: OAuthFlow
	implicit?: OAuthFlow
	password?: OAuthFlow
}>

/** What a security scheme is: the credential it sends and where it sends it. */
export type SchemeKind =
	| Readonly<{ in: "cookie"; name: CookieName; type: "apiKey" }>
	| Readonly<{ in: "header"; name: HeaderName; type: "apiKey" }>
	| Readonly<{ in: "query"; name: WireName; type: "apiKey" }>
	| Readonly<{ scheme: "basic" | "bearer"; type: "http" }>
	| Readonly<{
			flows: OAuthFlows
			/** The 3.2 metadata URL, shown in help and never fetched (design 9 I3). */
			oauth2MetadataUrl?: SafeText
			type: "oauth2Token"
	  }>
	| Readonly<{ openIdConnectUrl: SafeText; type: "oidcToken" }>
	| Readonly<{ type: "mutualTls" }>

/** Where the operator's credential for a scheme can come from. */
export type CredentialSource = "env" | "file" | "prompt"

/** A declared security scheme; flows and discovery URLs are recorded for help only. */
export type SecurityScheme = Readonly<{
	credentialSources: ReadonlyArray<CredentialSource>
	deprecated: boolean
	kind: SchemeKind
	name: string
	origin: Origin
	rows: Rows
	/** Where the scheme came from; an author-supplied one must not reach help or the report unmarked. */
	source: "spec" | "author-supplied"
}>

/** Alternatives are OR in document order; each alternative's uses are AND. */
export type SecurityPolicy = Readonly<{
	alternatives: ReadonlyArray<
		Readonly<{ uses: ReadonlyArray<Readonly<{ scheme: string; scopes: ReadonlyArray<string> }>> }>
	>
	declared: boolean
	origin: Origin
	rows: Rows
}>

/** The one schema store: each stored draft 2020-12 definition by its `$defs` key. */
export type SchemaStore = Readonly<{
	defs: Readonly<Record<string, Json>>
	origin: Origin
	rows: Rows
}>

/** An element that is read and counted but never affects requests. */
export type Informational = Readonly<{ origin: Origin; reason: SafeText; row: RowId }>

/**
 * One naming extension source of an operation or alias (design 4.4): a group as its segments, top level first, and a
 * method name, both unfolded, at least one of them, as `hintOf` reads them. `pointer` is the object that holds the
 * keys, so a key's own pointer is `pointer` plus the key.
 */
export type NamingHint = Readonly<{
	group?: Arr.NonEmptyReadonlyArray<string>
	method?: string
	pointer: JsonPointer
}>

/**
 * One usable entry of `x-forge-aliases`: its own Forge and Fern hints, never the operation's, its own `operationId`
 * (never the operation's), and its index in the array.
 */
export type NamingAlias = Readonly<{
	fern?: NamingHint
	forge?: NamingHint
	index: number
	operationId?: string
}>

/**
 * The naming extensions an operation carries (design 4.4, D-NAME4), at least one of them, as `namingOf` reads them:
 * its own Forge and Fern hints name its primary command, and each alias names one more command for it. Absent when
 * the operation has no usable naming extension.
 */
export type Naming = Readonly<{
	aliases?: Arr.NonEmptyReadonlyArray<NamingAlias>
	fern?: NamingHint
	forge?: NamingHint
}>

/** One operation, keyed by method token and path template. */
export type Operation = Readonly<{
	body?: Body
	deprecated: boolean
	docs: Docs
	key: Readonly<{ method: MethodToken; path: PathTemplate }>
	naming?: Naming
	operationId?: string
	origin: Origin
	parameters: ReadonlyArray<Parameter>
	responses: ReadonlyArray<ResponseCase>
	rows: Rows
	security: SecurityPolicy
	servers: ReadonlyArray<Server>
	tags: ReadonlyArray<SafeText>
}>

/** A Tag Object: its name, its help text, and its 3.2 `kind` and `parent`. */
export type Tag = Readonly<{ docs?: Docs; kind?: string; name: string; parent?: string }>

/** The normalized model of one API document set. */
export type Api = Readonly<{
	documents: ReadonlyArray<DocumentUri>
	entry: DocumentUri
	info: Docs
	informational: ReadonlyArray<Informational>
	line: SpecLine
	openapi: string
	operations: ReadonlyArray<Operation>
	origin: Origin
	rows: Rows
	schemas: SchemaStore
	securitySchemes: ReadonlyArray<SecurityScheme>
	servers: ReadonlyArray<Server>
	tags: ReadonlyArray<Tag>
}>
