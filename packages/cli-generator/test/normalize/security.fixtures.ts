/** What the property of security.test.ts reads: its security sketches and the model the specification states for them. */

import {
	array,
	boolean,
	constant,
	type Gen,
	map,
	oneOf,
	option,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import { pointerOrder } from "#model/diagnostic.ts"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import {
	configText,
	documentAt,
	entryText,
	lineGen,
	normalizedAt,
	token
} from "#test/support/normalizing.ts"

/** A text a help line shows: safe parts with unsafe characters (controls, bidi and format characters) between them. */
type Prose = Readonly<{ parts: Arr.NonEmptyReadonlyArray<string>; noise: string }>

/** The http authentication schemes a spec may write, in the spellings drawn. */
type HttpScheme = "basic" | "Basic" | "bearer" | "Bearer" | "digest"

/** Where an apiKey goes and under which name, valid or not for its location. */
type KeyPlace =
	| Readonly<{
			in: "header"
			name: "X-Key" | "X-Api-Key" | "authorization" | "Authorization" | "bad name"
	  }>
	| Readonly<{ in: "query"; name: "api_key" }>
	| Readonly<{ in: "cookie"; name: "sid" | "a b" }>

/** The OAuth 2 flows; a device authorization flow is 3.2's. */
type FlowKind =
	| "authorizationCode"
	| "clientCredentials"
	| "implicit"
	| "password"
	| "deviceAuthorization"

/** One flow: its scopes by name with their descriptions, and whether it names a refresh URL. */
type Flow = Readonly<{
	kind: FlowKind
	scopes: ReadonlyArray<readonly [name: string, description: Prose]>
	refresh: boolean
}>

/** A Security Scheme Object's kind, as drawn. */
type Kind =
	| Readonly<{ type: "apiKey"; place: KeyPlace }>
	| Readonly<{ type: "http"; scheme: HttpScheme }>
	| Readonly<{ type: "mutualTLS" }>
	| Readonly<{
			type: "oauth2"
			flows: Arr.NonEmptyReadonlyArray<Flow>
			metadata: Option.Option<Prose>
	  }>
	| Readonly<{ type: "openIdConnect"; url: Prose }>

/** A deprecated mark as written: absent, or a boolean. */
type Deprecated = Option.Option<boolean>

/** A declared or added scheme. */
type Scheme = Readonly<{ name: string; kind: Kind; deprecated: Deprecated }>

/** A security requirement: the schemes one alternative uses together, each with its scopes. */
type Requirement = ReadonlyArray<readonly [name: string, scopes: ReadonlyArray<string>]>

/** The author config's `security`: what `security.add` adds, and a declared scheme given its environment name. */
type AuthorSecurity = Readonly<{
	add: Option.Option<
		Readonly<{ schemes: ReadonlyArray<Scheme>; requirement: ReadonlyArray<Requirement> }>
	>
	env: Option.Option<string>
}>

/** A document's security: its declared schemes, the root and operation lists, and the author config's part. */
type SecuritySketch = Readonly<{
	line: SpecLine
	declared: ReadonlyArray<Scheme>
	root: Option.Option<ReadonlyArray<Requirement>>
	operation: Option.Option<ReadonlyArray<Requirement>>
	author: AuthorSecurity
}>

/** What a case reaches. */
export type SecurityFeature =
	| "apiKey scheme"
	| "http basic scheme"
	| "http bearer scheme"
	| "unsupported http scheme"
	| "mutualTLS scheme"
	| "oauth2 scheme"
	| "openIdConnect scheme"
	| "invalid apiKey name"
	| "deprecated scheme"
	| "metadata URL recorded"
	| "metadata URL left out"
	| "unsafe characters stripped"
	| "operation list over the root"
	| "root list inherited"
	| "no security declared"
	| "conflicting Authorization"
	| "undeclared scheme named"
	| "unusable scheme named"
	| "operation refused with no alternative left"
	| "anonymous alternative"
	| "added scheme applied"
	| "added scheme collides"
	| "spec requirement names an added scheme"
	| "scheme environment name"

const unsafe: Gen<string> = oneOf([
	constant("\u0000"),
	constant("\u0007"),
	constant("‮"),
	constant("​"),
	constant("­"),
	constant(" ")
])

/** A URL with unsafe characters drawn between its parts, or none. */
const urlProse = (base: string): Gen<Prose> =>
	weighted([
		[2, constant<Prose>({ parts: [base], noise: "" })],
		[1, map(unsafe, (noise): Prose => ({ parts: [`${base}/`, "meta"], noise }))]
	])

const scopeProse: Gen<Prose> = weighted([
	[2, constant<Prose>({ parts: ["Read pets"], noise: "" })],
	[1, map(unsafe, (noise): Prose => ({ parts: ["Administer ", "the store"], noise }))]
])

/** The text a prose writes: its parts joined by its noise. */
const written = (prose: Prose): string => Arr.join(prose.parts, prose.noise)

/** The text help shows: the parts alone. */
const shown = (prose: Prose): string => Arr.join(prose.parts, "")

const keyPlace: Gen<KeyPlace> = oneOf([
	constant<KeyPlace>({ in: "header", name: "X-Key" }),
	constant<KeyPlace>({ in: "header", name: "authorization" }),
	constant<KeyPlace>({ in: "header", name: "Authorization" }),
	constant<KeyPlace>({ in: "header", name: "bad name" }),
	constant<KeyPlace>({ in: "query", name: "api_key" }),
	constant<KeyPlace>({ in: "cookie", name: "sid" }),
	constant<KeyPlace>({ in: "cookie", name: "a b" })
])

const httpScheme: Gen<HttpScheme> = oneOf([
	constant<HttpScheme>("basic"),
	constant<HttpScheme>("Basic"),
	constant<HttpScheme>("bearer"),
	constant<HttpScheme>("Bearer"),
	constant<HttpScheme>("digest")
])

const scopes: Gen<Flow["scopes"]> = (source) =>
	subarray<readonly [string, Prose]>([
		["pets:read", scopeProse(source)],
		["admin", scopeProse(source)]
	])(source)

/** The flows a line admits, at least one, in the order the spec lists them. */
const flowsOn =
	(line: SpecLine): Gen<Arr.NonEmptyReadonlyArray<Flow>> =>
	(source) => {
		const kinds: Arr.NonEmptyReadonlyArray<FlowKind> = [
			"authorizationCode",
			"clientCredentials",
			"implicit",
			"password",
			...(line === "3.2" ? (["deviceAuthorization"] as const) : [])
		]
		const chosen = subarray(kinds)(source)
		const picked: Arr.NonEmptyReadonlyArray<FlowKind> = Arr.isReadonlyArrayNonEmpty(chosen)
			? chosen
			: [Arr.headNonEmpty(kinds)]
		return Arr.map(picked, (kind): Flow => ({
			kind,
			scopes: scopes(source),
			refresh: boolean(source)
		}))
	}

/** A scheme kind of `line`: mutualTLS from 3.1 on. */
const kindOn = (line: SpecLine): Gen<Kind> =>
	oneOf([
		map(keyPlace, (place): Kind => ({ type: "apiKey", place })),
		map(httpScheme, (scheme): Kind => ({ type: "http", scheme })),
		...(line === "3.0" ? [] : [constant<Kind>({ type: "mutualTLS" })]),
		(source): Kind => ({
			type: "oauth2",
			flows: flowsOn(line)(source),
			metadata: option(urlProse("https://auth.example/.well-known/oauth-authorization-server"))(
				source
			)
		}),
		map(urlProse("https://a.example/.well-known/openid-configuration"), (url): Kind => ({
			type: "openIdConnect",
			url
		}))
	])

/** The kinds an author may add: an apiKey header or an http scheme. */
const addedKind: Gen<Kind> = oneOf([
	constant<Kind>({ type: "apiKey", place: { in: "header", name: "X-Api-Key" } }),
	map(httpScheme, (scheme): Kind => ({ type: "http", scheme }))
])

const deprecated: Gen<Deprecated> = option(boolean)

/** A requirement over `names`: some of them, each with no scope or one. */
const requirementOver =
	(names: ReadonlyArray<string>): Gen<Requirement> =>
	(source) =>
		Arr.map(
			subarray(names)(source),
			(name) => [name, boolean(source) ? ["pets:read"] : []] as const
		)

/** A list of alternatives over `names`. */
const listOver = (names: ReadonlyArray<string>): Gen<ReadonlyArray<Requirement>> =>
	array(requirementOver(names), { min: 0, max: 3 })

/** A document's security, every scheme kind its line admits, with lists and an author config drawn over its names. */
export const securitySpace: Gen<SecuritySketch> = (source) => {
	const line = lineGen(source)
	const drawn = array((inner) => ({ kind: kindOn(line)(inner), deprecated: deprecated(inner) }), {
		min: 0,
		max: 3
	})(source)
	const declared = Arr.map(drawn, (scheme, index): Scheme => ({ name: `s${index}`, ...scheme }))
	const declaredNames = Arr.map(declared, (scheme) => scheme.name)
	const addedName = oneOf([constant("added"), ...Arr.map(declaredNames, (name) => constant(name))])(
		source
	)
	const add = option(
		(
			inner
		): Readonly<{ schemes: ReadonlyArray<Scheme>; requirement: ReadonlyArray<Requirement> }> => ({
			schemes: [{ name: addedName, kind: addedKind(inner), deprecated: deprecated(inner) }],
			requirement: listOver(Arr.dedupe([addedName, ...declaredNames, "ghost"]))(inner)
		})
	)(source)
	const specNames = Arr.dedupe([
		...declaredNames,
		"ghost",
		...(Option.isSome(add) ? [addedName] : [])
	])
	return {
		line,
		declared,
		root: option(listOver(specNames))(source),
		operation: option(listOver(specNames))(source),
		author: {
			add,
			env: Arr.isReadonlyArrayNonEmpty(declaredNames)
				? option(constant(Arr.headNonEmpty(declaredNames)))(source)
				: Option.none()
		}
	}
}

/** A flow's URL members, as the spec gives each kind. */
const flowUrls = (flow: Flow): Readonly<Record<string, string>> => {
	const refresh = flow.refresh ? { refreshUrl: "https://a.example/refresh" } : {}
	switch (flow.kind) {
		case "authorizationCode":
			return {
				authorizationUrl: "https://a.example/authorize",
				tokenUrl: "https://a.example/token",
				...refresh
			}
		case "implicit":
			return { authorizationUrl: "https://a.example/authorize", ...refresh }
		case "clientCredentials":
		case "password":
			return { tokenUrl: "https://a.example/token", ...refresh }
		case "deviceAuthorization":
			return {
				deviceAuthorizationUrl: "https://a.example/device",
				tokenUrl: "https://a.example/token",
				...refresh
			}
	}
}

/** The Security Scheme Object a scheme writes. */
const schemeNode = (scheme: Scheme): Json => {
	const marks = Option.match(scheme.deprecated, {
		onNone: () => ({}),
		onSome: (value) => ({ deprecated: value })
	})
	const kind = scheme.kind
	switch (kind.type) {
		case "apiKey":
			return { ...marks, in: kind.place.in, name: kind.place.name, type: "apiKey" }
		case "http":
			return { ...marks, scheme: kind.scheme, type: "http" }
		case "mutualTLS":
			return { ...marks, type: "mutualTLS" }
		case "oauth2":
			return {
				...marks,
				flows: Rec.fromEntries(
					Arr.map(kind.flows, (flow): readonly [string, Json] => [
						flow.kind,
						{
							...flowUrls(flow),
							scopes: Rec.fromEntries(
								Arr.map(flow.scopes, ([name, description]): readonly [string, Json] => [
									name,
									written(description)
								])
							)
						}
					])
				),
				...Option.match(kind.metadata, {
					onNone: () => ({}),
					onSome: (url) => ({ oauth2MetadataUrl: written(url) })
				}),
				type: "oauth2"
			}
		case "openIdConnect":
			return { ...marks, openIdConnectUrl: written(kind.url), type: "openIdConnect" }
	}
}

/** A requirement list as the spec writes it. */
const listJson = (list: ReadonlyArray<Requirement>): Json =>
	Arr.map(list, (requirement) =>
		Rec.fromEntries(
			Arr.map(requirement, ([name, needed]): readonly [string, Json] => [name, needed])
		)
	)

/** The document a sketch describes: its schemes, its root list and its one operation's. */
const documentOf = (sketch: SecuritySketch): Json =>
	documentAt(sketch.line, {
		components: {
			securitySchemes: Rec.fromEntries(
				Arr.map(sketch.declared, (scheme): readonly [string, Json] => [
					scheme.name,
					schemeNode(scheme)
				])
			)
		},
		paths: {
			"/a": {
				get: {
					responses: { "200": { description: "ok" } },
					...Option.match(sketch.operation, {
						onNone: () => ({}),
						onSome: (list) => ({ security: listJson(list) })
					})
				}
			}
		},
		...Option.match(sketch.root, {
			onNone: () => ({}),
			onSome: (list) => ({ security: listJson(list) })
		})
	})

/** The author config's members a sketch writes. */
const configMembers = (sketch: SecuritySketch): Readonly<Record<string, Json>> => {
	const added = Option.match(sketch.author.add, {
		onNone: () => ({}),
		onSome: (add) => ({
			add: {
				requirement: listJson(add.requirement),
				schemes: Rec.fromEntries(
					Arr.map(add.schemes, (scheme): readonly [string, Json] => [
						scheme.name,
						schemeNode(scheme)
					])
				)
			}
		})
	})
	const env = Option.match(sketch.author.env, {
		onNone: () => ({}),
		onSome: (name) => ({ [name]: { env: "EXAMPLE_KEY" } })
	})
	return Option.isSome(sketch.author.add) || Option.isSome(sketch.author.env)
		? { security: { ...added, ...env } }
		: {}
}

/** A diagnostic as the model states it: its document, code, scope, pointer and related pointers, never its prose. */
type Located = Readonly<{
	document: string
	code: string
	scope: string
	pointer: string
	related: ReadonlyArray<string>
}>

/** A scheme as the model records it. */
type ModelScheme = Readonly<{
	name: string
	source: "spec" | "author-supplied"
	deprecated: boolean
	kind: Json
}>

/** One normalization's security, as the specification states it. */
type SecurityModel = Readonly<{
	schemes: ReadonlyArray<ModelScheme>
	alternatives: Option.Option<ReadonlyArray<Requirement>>
	findings: ReadonlyArray<Located>
}>

/** A scheme modelled: the scheme, or not usable; with the findings it raises. */
type Built = Readonly<{ scheme: Option.Option<ModelScheme>; findings: ReadonlyArray<Located> }>

const flowRows: Readonly<Record<FlowKind, string>> = {
	authorizationCode: "OAF-05",
	clientCredentials: "OAF-04",
	deviceAuthorization: "OAF-06",
	implicit: "OAF-02",
	password: "OAF-03"
}

/** A flow as help records it: its URLs and its scopes, sanitized. */
const flowHelp = (flow: Flow): Json => ({
	...flowUrls(flow),
	scopes: Arr.map(flow.scopes, ([name, description]) => ({ description: shown(description), name }))
})

/** The kind a usable scheme records, or none when the scheme cannot be used. */
const kindModel = (kind: Kind, line: SpecLine): Option.Option<Json> => {
	switch (kind.type) {
		case "apiKey":
			return kind.place.name === "bad name" || kind.place.name === "a b"
				? Option.none()
				: Option.some({ in: kind.place.in, name: kind.place.name, type: "apiKey" })
		case "http":
			return kind.scheme === "digest"
				? Option.none()
				: Option.some({ scheme: Str.toLowerCase(kind.scheme), type: "http" })
		case "mutualTLS":
			return Option.some({ type: "mutualTls" })
		case "oauth2":
			return Option.some({
				flows: Rec.fromEntries(
					Arr.map(kind.flows, (flow): readonly [string, Json] => [flow.kind, flowHelp(flow)])
				),
				...(line === "3.2"
					? Option.match(kind.metadata, {
							onNone: () => ({}),
							onSome: (url) => ({ oauth2MetadataUrl: shown(url) })
						})
					: {}),
				type: "oauth2Token"
			})
		case "openIdConnect":
			return Option.some({ openIdConnectUrl: shown(kind.url), type: "oidcToken" })
	}
}

/** The refusal an unusable kind raises: an unsupported http scheme, or a name its location cannot carry. */
const refusalCode = (kind: Kind): string => {
	switch (kind.type) {
		case "apiKey":
			return kind.place.in === "cookie"
				? "SSC-14/invalid-cookie-name"
				: "SSC-12/invalid-header-name"
		case "http":
		case "mutualTLS":
		case "oauth2":
		case "openIdConnect":
			return "SSC-17/unsupported-scheme"
	}
}

/** The token-acquisition refusals a usable kind raises: each OAuth flow's, or OpenID Connect's discovery. */
const acquisition = (kind: Kind, pointer: string, document: string): ReadonlyArray<Located> => {
	switch (kind.type) {
		case "oauth2":
			return Arr.map(kind.flows, (flow) => ({
				document,
				code: `${flowRows[flow.kind]}/token-acquisition`,
				scope: "element",
				pointer: `${pointer}/flows/${flow.kind}`,
				related: []
			}))
		case "openIdConnect":
			return [
				{ document, code: "SSC-19/token-acquisition", scope: "element", pointer, related: [] }
			]
		case "apiKey":
		case "http":
		case "mutualTLS":
			return []
	}
}

/** One scheme modelled where it is declared (or added), under `line`. */
const built = (
	scheme: Scheme,
	line: SpecLine,
	source: ModelScheme["source"],
	pointer: string
): Built => {
	const document = source === "spec" ? entryText : configText
	return Option.match(kindModel(scheme.kind, line), {
		onNone: (): Built => ({
			scheme: Option.none(),
			findings: [
				{ document, code: refusalCode(scheme.kind), scope: "element", pointer, related: [] }
			]
		}),
		onSome: (kind): Built => ({
			scheme: Option.some({
				name: scheme.name,
				source,
				deprecated: Option.getOrElse(scheme.deprecated, () => false),
				kind
			}),
			findings: acquisition(scheme.kind, pointer, document)
		})
	})
}

/** The schemes a scope reaches by name: usable ones, and the names of the unusable. */
type Scope = Readonly<{ usable: ReadonlyMap<string, ModelScheme>; unusable: ReadonlySet<string> }>

/** Whether a scheme writes the one Authorization header: http, OAuth 2, OpenID Connect, or an apiKey header so named. */
const setsAuthorization = (scheme: ModelScheme, kinds: ReadonlyMap<string, Kind>): boolean =>
	Option.match(Option.fromUndefinedOr(kinds.get(`${scheme.source} ${scheme.name}`)), {
		onNone: () => false,
		onSome: (kind) =>
			kind.type === "apiKey"
				? kind.place.in === "header" && Str.toLowerCase(kind.place.name) === "authorization"
				: kind.type === "http" || kind.type === "oauth2" || kind.type === "openIdConnect"
	})

/** Where a scheme is declared or added. */
const originOf = (scheme: ModelScheme): string =>
	scheme.source === "spec"
		? `/components/securitySchemes/${token(scheme.name)}`
		: `/security/add/schemes/${token(scheme.name)}`

/** A list judged: what each alternative raises, and the alternatives that stay. */
type Judged = Readonly<{ findings: ReadonlyArray<Located>; kept: ReadonlyArray<Requirement> }>

/** A list judged at `pointer` (in `document`) against `scope`. */
const judged = (
	list: ReadonlyArray<Requirement>,
	pointer: string,
	document: string,
	scope: Scope,
	line: SpecLine,
	kinds: ReadonlyMap<string, Kind>
): Judged => {
	const each = Arr.map(list, (requirement, index): Judged => {
		const at = `${pointer}/${index}`
		const named = Arr.flatMap(requirement, ([name]): ReadonlyArray<Located> => {
			if (scope.usable.has(name)) {
				return []
			}
			return scope.unusable.has(name)
				? [
						{
							document,
							code: "SEC-02/unusable-scheme",
							scope: "element",
							pointer: `${at}/${token(name)}`,
							related: [`/components/securitySchemes/${token(name)}`]
						}
					]
				: [
						{
							document,
							code: `${line === "3.2" ? "SEC-10" : "SEC-09"}/undeclared-scheme`,
							scope: "element",
							pointer: `${at}/${token(name)}`,
							related: []
						}
					]
		})
		const writers = Arr.filter(
			Arr.getSomes(
				Arr.map(requirement, ([name]) => Option.fromUndefinedOr(scope.usable.get(name)))
			),
			(scheme) => setsAuthorization(scheme, kinds)
		)
		const conflict: ReadonlyArray<Located> =
			writers.length < 2
				? []
				: [
						{
							document,
							code: "SEC-01/conflicting-authorization",
							scope: "element",
							pointer: at,
							related: Arr.map(writers, originOf)
						}
					]
		const findings = [...named, ...conflict]
		return { findings, kept: Arr.isReadonlyArrayNonEmpty(findings) ? [] : [requirement] }
	})
	return {
		findings: Arr.flatMap(each, (one) => one.findings),
		kept: Arr.flatMap(each, (one) => one.kept)
	}
}

/** Diagnostics in the order design 3.7 states: the entry before the config, then pointer, then code. */
const findingOrder: Order.Order<Located> = Order.combineAll([
	Order.mapInput(Order.Number, (found: Located) => (found.document === entryText ? 0 : 1)),
	Order.mapInput(pointerOrder, (found: Located) => found.pointer),
	Order.mapInput(Order.String, (found: Located) => found.code)
])

/** Each finding once, by everything it says. */
const distinct = (findings: ReadonlyArray<Located>): ReadonlyArray<Located> =>
	Arr.dedupeWith(
		findings,
		(left, right) =>
			left.document === right.document &&
			left.code === right.code &&
			left.pointer === right.pointer &&
			Arr.join(left.related, " ") === Arr.join(right.related, " ")
	)

/** A list as a policy judges it: where it stands, in which document, and the scope its names reach. */
type Policy = Readonly<{
	list: ReadonlyArray<Requirement>
	pointer: string
	document: string
	scope: Scope
}>

/** The security normalize gives the sketch, as design 6.5 states it. */
export const expectedOf = (sketch: SecuritySketch): SecurityModel => {
	const declaredNames = new Set(Arr.map(sketch.declared, (scheme) => scheme.name))
	const declared = Arr.map(sketch.declared, (scheme) =>
		built(scheme, sketch.line, "spec", `/components/securitySchemes/${token(scheme.name)}`)
	)
	const addedSchemes = Option.match(sketch.author.add, {
		onNone: () => [],
		onSome: (add) => add.schemes
	})
	const added = Arr.map(addedSchemes, (scheme): Built =>
		declaredNames.has(scheme.name)
			? {
					scheme: Option.none(),
					findings: [
						{
							document: configText,
							code: "CFG-1/scheme-name-collision",
							scope: "document",
							pointer: `/security/add/schemes/${token(scheme.name)}`,
							related: []
						}
					]
				}
			: built(scheme, sketch.line, "author-supplied", `/security/add/schemes/${token(scheme.name)}`)
	)
	const usableOf = (all: ReadonlyArray<Built>) => Arr.getSomes(Arr.map(all, (one) => one.scheme))
	const unusableNames = (schemes: ReadonlyArray<Scheme>, all: ReadonlyArray<Built>) =>
		Arr.getSomes(
			Arr.map(Arr.zip(schemes, all), ([scheme, one]) =>
				Option.isNone(one.scheme) ? Option.some(scheme.name) : Option.none()
			)
		)
	const addedUnusable = Arr.filter(
		unusableNames(addedSchemes, added),
		(name) => !declaredNames.has(name)
	)
	const specScope: Scope = {
		usable: new Map(Arr.map(usableOf(declared), (scheme) => [scheme.name, scheme])),
		unusable: new Set(unusableNames(sketch.declared, declared))
	}
	const authorScope: Scope = {
		usable: new Map(
			Arr.map([...usableOf(declared), ...usableOf(added)], (scheme) => [scheme.name, scheme])
		),
		unusable: new Set([...unusableNames(sketch.declared, declared), ...addedUnusable])
	}
	const kinds = new Map([
		...Arr.map(sketch.declared, (scheme) => [`spec ${scheme.name}`, scheme.kind] as const),
		...Arr.map(addedSchemes, (scheme) => [`author-supplied ${scheme.name}`, scheme.kind] as const)
	])
	const supplied = Option.map(sketch.author.add, (add): Policy => ({
		list: add.requirement,
		pointer: "/security/add/requirement",
		document: configText,
		scope: authorScope
	}))
	const rootList = Option.map(sketch.root, (list): Policy => ({
		list,
		pointer: "/security",
		document: entryText,
		scope: specScope
	}))
	const operationList = Option.map(sketch.operation, (list): Policy => ({
		list,
		pointer: "/paths/~1a/get/security",
		document: entryText,
		scope: specScope
	}))
	const rootPolicy = Option.orElse(rootList, () => supplied)
	const operationPolicy = Option.orElse(operationList, () => rootPolicy)
	const judge = (policy: Option.Option<Policy>): Judged =>
		Option.match(policy, {
			onNone: (): Judged => ({ findings: [], kept: [] }),
			onSome: (chosen) =>
				judged(chosen.list, chosen.pointer, chosen.document, chosen.scope, sketch.line, kinds)
		})
	const atRoot = judge(rootPolicy)
	const atOperation = judge(operationPolicy)
	const listed = Option.match(operationPolicy, {
		onNone: () => 0,
		onSome: (chosen) => chosen.list.length
	})
	const refused = listed > 0 && atOperation.kept.length === 0
	const raised: ReadonlyArray<Located> = refused
		? [
				{
					document: entryText,
					code: "SEC-06/no-satisfiable-alternative",
					scope: "operation",
					pointer: "/paths/~1a/get",
					related: Option.match(operationPolicy, {
						onNone: () => [],
						onSome: (chosen) => [chosen.pointer]
					})
				}
			]
		: []
	return {
		schemes: [...usableOf(declared), ...usableOf(added)],
		alternatives: refused ? Option.none() : Option.some(atOperation.kept),
		findings: Arr.sort(
			distinct([
				...Arr.flatMap(declared, (one) => one.findings),
				...Arr.flatMap(added, (one) => one.findings),
				...atRoot.findings,
				...atOperation.findings,
				...raised
			]),
			findingOrder
		)
	}
}

/** The security normalize gives the sketch's document under its author config. */
export const actualOf = (sketch: SecuritySketch) =>
	Effect.gen(function* () {
		const { api, diagnostics } = yield* normalizedAt(
			sketch.line,
			documentOf(sketch),
			configMembers(sketch)
		)
		const operation = Arr.head(api.operations)
		return {
			schemes: Arr.map(api.securitySchemes, (scheme) => ({
				name: scheme.name,
				source: scheme.source,
				deprecated: scheme.deprecated,
				kind: scheme.kind
			})),
			alternatives: Option.map(operation, (found) =>
				Arr.map(found.security.alternatives, (alternative) =>
					Arr.map(alternative.uses, (use) => [use.scheme, use.scopes] as const)
				)
			),
			findings: Arr.map(diagnostics, (diagnostic): Located => ({
				document: diagnostic.document,
				code: diagnostic.code,
				scope: diagnostic.scope,
				pointer: String(diagnostic.pointer),
				related: Arr.map(diagnostic.related ?? [], (site) => String(site.pointer))
			}))
		}
	})

/** The feature a scheme's kind reaches. */
const kindFeature = (kind: Kind): SecurityFeature => {
	switch (kind.type) {
		case "apiKey":
			return kind.place.name === "bad name" || kind.place.name === "a b"
				? "invalid apiKey name"
				: "apiKey scheme"
		case "http":
			return kind.scheme === "digest"
				? "unsupported http scheme"
				: Str.toLowerCase(kind.scheme) === "basic"
					? "http basic scheme"
					: "http bearer scheme"
		case "mutualTLS":
			return "mutualTLS scheme"
		case "oauth2":
			return "oauth2 scheme"
		case "openIdConnect":
			return "openIdConnect scheme"
	}
}

/** The prose a kind writes, each a help text. */
const proseOf = (kind: Kind): ReadonlyArray<Prose> => {
	switch (kind.type) {
		case "oauth2":
			return [
				...Option.toArray(kind.metadata),
				...Arr.flatMap(kind.flows, (flow) => Arr.map(flow.scopes, ([, description]) => description))
			]
		case "openIdConnect":
			return [kind.url]
		case "apiKey":
		case "http":
		case "mutualTLS":
			return []
	}
}

/** The features a sketch and its model reach. */
export const securityFeatures = (
	sketch: SecuritySketch,
	model: SecurityModel
): ReadonlyArray<SecurityFeature> => {
	const added = Option.match(sketch.author.add, { onNone: () => [], onSome: (add) => add.schemes })
	const declaredNames = new Set(Arr.map(sketch.declared, (scheme) => scheme.name))
	const freshAdded = Arr.filter(added, (scheme) => !declaredNames.has(scheme.name))
	const kinds = Arr.map([...sketch.declared, ...added], (scheme) => scheme.kind)
	const codes = new Set(Arr.map(model.findings, (found) => found.code))
	const specLists = [...Option.toArray(sketch.root), ...Option.toArray(sketch.operation)]
	const names = (lists: ReadonlyArray<ReadonlyArray<Requirement>>) =>
		new Set(
			Arr.flatMap(lists, (list) =>
				Arr.flatMap(list, (requirement) => Arr.map(requirement, ([name]) => name))
			)
		)
	const specNamed = names(specLists)
	const metadata = Arr.some(kinds, (kind) => kind.type === "oauth2" && Option.isSome(kind.metadata))
	const facts: ReadonlyArray<readonly [boolean, SecurityFeature]> = [
		[
			Arr.some(sketch.declared, (scheme) => Option.getOrElse(scheme.deprecated, () => false)),
			"deprecated scheme"
		],
		[metadata && sketch.line === "3.2", "metadata URL recorded"],
		[metadata && sketch.line !== "3.2", "metadata URL left out"],
		[
			Arr.some(Arr.flatMap(kinds, proseOf), (prose) => prose.noise !== ""),
			"unsafe characters stripped"
		],
		[Option.isSome(sketch.operation) && Option.isSome(sketch.root), "operation list over the root"],
		[Option.isNone(sketch.operation) && Option.isSome(sketch.root), "root list inherited"],
		[
			Option.isNone(sketch.operation) &&
				Option.isNone(sketch.root) &&
				Option.isNone(sketch.author.add),
			"no security declared"
		],
		[codes.has("SEC-01/conflicting-authorization"), "conflicting Authorization"],
		[
			codes.has("SEC-09/undeclared-scheme") || codes.has("SEC-10/undeclared-scheme"),
			"undeclared scheme named"
		],
		[codes.has("SEC-02/unusable-scheme"), "unusable scheme named"],
		[codes.has("SEC-06/no-satisfiable-alternative"), "operation refused with no alternative left"],
		[
			Option.exists(model.alternatives, (kept) =>
				Arr.some(kept, (requirement) => requirement.length === 0)
			),
			"anonymous alternative"
		],
		[
			Option.isNone(sketch.operation) &&
				Option.isNone(sketch.root) &&
				Arr.some(model.schemes, (scheme) => scheme.source === "author-supplied"),
			"added scheme applied"
		],
		[codes.has("CFG-1/scheme-name-collision"), "added scheme collides"],
		[
			Arr.some(freshAdded, (scheme) => specNamed.has(scheme.name)),
			"spec requirement names an added scheme"
		],
		[Option.isSome(sketch.author.env), "scheme environment name"]
	]
	return [
		...Arr.map(kinds, kindFeature),
		...Arr.map(
			Arr.filter(facts, ([holds]) => holds),
			([, feature]) => feature
		)
	]
}
