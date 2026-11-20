/**
 * What the property of credential-collision-mtls.test.ts reads: security schemes of every kind the runtime sends, under
 * names drawn to fold alike, to fold to nothing, and to take the runtime's own environment names; one operation using
 * each; author-config environment overrides for some, and for names no scheme has; the pipeline's plan for them
 * (resolve, normalize, the names plan, in process); and design 4.4's credential names, as a model.
 */

import {
	aimed,
	type Aimed,
	array,
	constant,
	element,
	type Gen,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Order, Record, String as Str } from "effect"
import { decodeAuthorConfig } from "#model/author-config.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"
import { planNames } from "#names/index.ts"
import { reservedFlagNames } from "#names/reserved.ts"
import { normalize } from "#normalize/index.ts"
import { resolve } from "#resolve/index.ts"

/** How a scheme sends its credential: a token (bearer, basic, an API key header) or a client certificate. */
type Kind = "bearer" | "basic" | "apiKey" | "mutualTLS"

/** One scheme: its name and kind, and the environment name the author config gives it, if any. */
type Scheme = Readonly<{ name: string; kind: Kind; env: Option.Option<string> }>

/** One case: the schemes (each used by its own operation), the env prefix, and config overrides naming no scheme. */
export type CredentialCase = Readonly<{
	schemes: ReadonlyArray<Scheme>
	prefix: Option.Option<string>
	strays: ReadonlyArray<string>
}>

/** Scheme names: ones folding alike, ones folding to the runtime's own settings, ones folding to nothing, plain ones. */
const NAMES = [
	"bearerAuth",
	"bearer_auth",
	"BearerAuth",
	"client",
	"Client",
	"client-cert",
	"partner",
	"apiKey",
	"petAuth",
	"pet_auth",
	"baseUrl",
	"timeout",
	"idleTimeout",
	"errorFormat",
	"_",
	"verbose"
] as const

const schemeJson = (kind: Kind): Json => {
	switch (kind) {
		case "bearer":
			return { scheme: "bearer", type: "http" }
		case "basic":
			return { scheme: "basic", type: "http" }
		case "apiKey":
			return { in: "header", name: "X-Key", type: "apiKey" }
		case "mutualTLS":
			return { type: "mutualTLS" }
	}
}

/** The operation id the scheme at `index` is used by: plain words, so commands are named as written. */
const operationOf = (index: number): string => `use${"abcdefghijklmnop"[index] ?? "z"}`

const documentOf = (c: CredentialCase): Json => ({
	components: {
		securitySchemes: Record.fromEntries(
			Arr.map(c.schemes, (scheme) => [scheme.name, schemeJson(scheme.kind)] as const)
		)
	},
	info: { title: "Credentials", version: "1.0.0" },
	openapi: "3.1.1",
	paths: Record.fromEntries([
		...Arr.map(
			c.schemes,
			(scheme, index) =>
				[
					`/${operationOf(index)}`,
					{
						get: {
							operationId: operationOf(index),
							responses: { "204": { description: "Done." } },
							security: [{ [scheme.name]: [] }]
						}
					}
				] as const
		),
		[
			"/open",
			{ get: { operationId: "open", responses: { "204": { description: "Done." } } } }
		] as const
	])
})

const configOf = (c: CredentialCase): Json => ({
	binName: "mtls",
	...Option.match(c.prefix, { onNone: () => ({}), onSome: (envPrefix) => ({ envPrefix }) }),
	package: { name: "mtls-cli", version: "1.0.0" },
	servers: { accepted: ["https://api.example.com"] },
	...(Arr.isReadonlyArrayEmpty(c.strays) && Arr.every(c.schemes, (s) => Option.isNone(s.env))
		? {}
		: {
				security: Record.fromEntries([
					...Arr.flatMap(c.schemes, (s) =>
						Option.match(s.env, { onNone: () => [], onSome: (env) => [[s.name, { env }] as const] })
					),
					...Arr.map(c.strays, (name) => [name, { env: "STRAY_TOKEN" }] as const)
				])
			})
})

/** What the plan answers: the commands it plans, its diagnostics, and the token credentials of the schemes it keeps. */
export type Answer = Readonly<{
	commands: ReadonlyArray<string>
	diagnostics: ReadonlyArray<
		readonly [code: string, scope: string, severity: string, pointer: string]
	>
	credentials: ReadonlyArray<readonly [scheme: string, env: string, flag: string]>
}>

const diagnosticOrder = Order.combineAll<Answer["diagnostics"][number]>([
	Order.mapInput(Order.String, (d) => d[3]),
	Order.mapInput(Order.String, (d) => d[0])
])

export const actualOf = (c: CredentialCase) =>
	Effect.gen(function* () {
		const document = fixedDocumentUri("file:///mtls/openapi.json")
		const configDocument = fixedDocumentUri("file:///mtls/author-config.json")
		const config = yield* decodeAuthorConfig(configOf(c), { document: configDocument })
		const resolution = yield* resolve({ document, line: "3.1", value: documentOf(c) })
		const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument })
		const plan = yield* planNames(api, { config, configDocument, strict: false })
		const kept = new Set(Arr.map(expectedKept(c), (s) => s.name))
		const answer: Answer = {
			commands: Arr.sort(
				Arr.map(
					[...plan.root, ...Arr.flatMap(plan.groups, (g) => g.commands)],
					(command) => command.name
				),
				Order.String
			),
			diagnostics: Arr.sort(
				Arr.map(plan.diagnostics, (d) => [d.code, d.scope, d.severity, d.pointer] as const),
				diagnosticOrder
			),
			credentials: Arr.sort(
				Arr.flatMap(plan.credentials, (credential) =>
					kept.has(credential.scheme)
						? [[credential.scheme, credential.env, credential.flag] as const]
						: []
				),
				Order.mapInput(Order.String, (entry: readonly [string, string, string]) => entry[0])
			)
		}
		return answer
	})

const camelBoundary = regex("(?<head>[a-z0-9])(?<tail>[A-Z])", "gu")

const alnum = regex("^[A-Za-z0-9]$", "u")

/** Design 4.4's scheme slug, as a walk: a dash between a small letter or digit and a capital, and for every run of other characters; none at either end; lower case. */
const slugOf = (name: string): string => {
	const spaced = Str.replaceAll(camelBoundary, "$<head>-$<tail>")(name)
	const words: Array<string> = []
	let current = ""
	for (const char of spaced) {
		if (alnum.test(char)) {
			current = Str.concat(current, char)
		} else {
			if (current !== "") {
				words.push(current)
			}
			current = ""
		}
	}
	if (current !== "") {
		words.push(current)
	}
	return Str.toLowerCase(Arr.join(words, "-"))
}

const screaming = (slug: string): string => Str.toUpperCase(Str.replaceAll("-", "_")(slug))

const prefixOf = (c: CredentialCase): string => Option.getOrElse(c.prefix, () => "MTLS")

/** The runtime's own settings an env name may not take (design 4.4): `<PREFIX>_` and each of them. */
const SETTINGS = ["BASE_URL", "ERROR_FORMAT", "IDLE_TIMEOUT", "TIMEOUT"] as const

/** A scheme's credential names: a token's env and file flag, or a certificate's three env names. */
type Names =
	| Readonly<{ tag: "token"; slug: string; env: string; flag: string }>
	| Readonly<{ tag: "certificate"; slug: string; envs: ReadonlyArray<string> }>

const namesOf = (c: CredentialCase, scheme: Scheme): Names => {
	const slug = slugOf(scheme.name)
	const stem = `${prefixOf(c)}_${screaming(slug)}`
	return scheme.kind === "mutualTLS"
		? { tag: "certificate", slug, envs: [`${stem}_CA`, `${stem}_CERT`, `${stem}_KEY`] }
		: { tag: "token", slug, env: Option.getOrElse(scheme.env, () => stem), flag: `${slug}-file` }
}

const envsOf = (names: Names): ReadonlyArray<string> =>
	names.tag === "token" ? [names.env] : names.envs

/** Whether a scheme's names collide: an env or flag another credential takes, a runtime setting, a reserved flag, or (for a token) a certificate's env. */
const clashes = (c: CredentialCase, scheme: Scheme): boolean => {
	const all = Arr.map(c.schemes, (s) => namesOf(c, s))
	const names = namesOf(c, scheme)
	if (names.slug === "") {
		return false
	}
	const envCount = (env: string): number =>
		Arr.length(Arr.filter(Arr.flatMap(all, envsOf), (other) => other === env))
	const settings = new Set(Arr.map(SETTINGS, (setting) => `${prefixOf(c)}_${setting}`))
	if (names.tag === "certificate") {
		return Arr.some(names.envs, (env) => envCount(env) > 1 || settings.has(env))
	}
	const flagCount = Arr.length(
		Arr.filter(all, (other) => other.tag === "token" && other.flag === names.flag)
	)
	const certificateEnvs = new Set(
		Arr.flatMap(all, (other) => (other.tag === "certificate" ? other.envs : []))
	)
	return (
		envCount(names.env) > 1 ||
		flagCount > 1 ||
		settings.has(names.env) ||
		certificateEnvs.has(names.env) ||
		reservedFlagNames.has(names.flag)
	)
}

/** The schemes whose operations the plan keeps: a slug, and no collision. */
const expectedKept = (c: CredentialCase): ReadonlyArray<Scheme> =>
	Arr.filter(c.schemes, (scheme) => namesOf(c, scheme).slug !== "" && !clashes(c, scheme))

/**
 * Design 4.4's answer: an operation using a scheme whose name folds to nothing is refused SSC-01/empty-name; one using a
 * scheme whose names collide is refused SSC-01/credential-collision; the rest are commands; a token scheme kept gets
 * `<PREFIX>_<SLUG>` (or its configured env) and `--<slug>-file`; an override naming no scheme is CFG-1/unmatched-override.
 */
export const expectedOf = (c: CredentialCase): Answer => {
	const kept = expectedKept(c)
	const refusals = Arr.flatMap(c.schemes, (scheme, index): Answer["diagnostics"] => {
		const pointer = `/paths/~1${operationOf(index)}/get`
		return namesOf(c, scheme).slug === ""
			? [["SSC-01/empty-name", "operation", "refusal", pointer]]
			: clashes(c, scheme)
				? [["SSC-01/credential-collision", "operation", "refusal", pointer]]
				: []
	})
	const unmatched = Arr.map(c.strays, (name): Answer["diagnostics"][number] => [
		"CFG-1/unmatched-override",
		"document",
		"notice",
		`/security/${name}`
	])
	return {
		commands: Arr.sort(
			[
				"open",
				...Arr.flatMap(c.schemes, (scheme, index) =>
					Arr.contains(kept, scheme) ? [operationOf(index)] : []
				)
			],
			Order.String
		),
		diagnostics: Arr.sort([...refusals, ...unmatched], diagnosticOrder),
		credentials: Arr.sort(
			Arr.flatMap(kept, (scheme) => {
				const names = namesOf(c, scheme)
				return names.tag === "token" ? [[scheme.name, names.env, names.flag] as const] : []
			}),
			Order.mapInput(Order.String, (entry: readonly [string, string, string]) => entry[0])
		)
	}
}

export type Feature =
	| "a token kept"
	| "a certificate kept"
	| "two tokens folding to one env"
	| "two certificates folding to one slug"
	| "a certificate env a token also takes"
	| `a token env taking ${(typeof SETTINGS)[number]}`
	| "a name folding to nothing"
	| "a configured env"
	| "an override naming no scheme"
	| "the prefix from the bin name"

export const featuresOf = (c: CredentialCase): ReadonlyArray<Feature> => {
	const all = Arr.map(c.schemes, (s) => [s, namesOf(c, s)] as const)
	const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	const kept = expectedKept(c)
	const tokens = Arr.filter(all, ([, n]) => n.tag === "token" && n.slug !== "")
	const certificates = Arr.filter(all, ([, n]) => n.tag === "certificate" && n.slug !== "")
	return [
		...when(
			Arr.some(kept, (s) => s.kind !== "mutualTLS"),
			"a token kept"
		),
		...when(
			Arr.some(kept, (s) => s.kind === "mutualTLS"),
			"a certificate kept"
		),
		...when(
			Arr.some(tokens, ([, a], i) =>
				Arr.some(
					Arr.drop(tokens, i + 1),
					([, b]) => a.tag === "token" && b.tag === "token" && a.env === b.env
				)
			),
			"two tokens folding to one env"
		),
		...when(
			Arr.some(certificates, ([, a], i) =>
				Arr.some(Arr.drop(certificates, i + 1), ([, b]) => a.slug === b.slug)
			),
			"two certificates folding to one slug"
		),
		...when(
			Arr.some(
				tokens,
				([, t]) =>
					t.tag === "token" &&
					Arr.some(
						certificates,
						([, cert]) => cert.tag === "certificate" && Arr.contains(cert.envs, t.env)
					)
			),
			"a certificate env a token also takes"
		),
		...Arr.flatMap(SETTINGS, (setting): ReadonlyArray<Feature> =>
			Arr.some(tokens, ([, t]) => t.tag === "token" && t.env === `${prefixOf(c)}_${setting}`)
				? [`a token env taking ${setting}`]
				: []
		),
		...when(
			Arr.some(all, ([, n]) => n.slug === ""),
			"a name folding to nothing"
		),
		...when(
			Arr.some(c.schemes, (s) => Option.isSome(s.env) && s.kind !== "mutualTLS"),
			"a configured env"
		),
		...when(Arr.isReadonlyArrayNonEmpty(c.strays), "an override naming no scheme"),
		...when(Option.isNone(c.prefix), "the prefix from the bin name")
	]
}

const kindGen = element<Kind>(["bearer", "basic", "apiKey", "mutualTLS"])

const schemesGen =
	(names: Gen<ReadonlyArray<string>>, kind: Gen<Kind>): Gen<ReadonlyArray<Scheme>> =>
	(s) =>
		Arr.map(s.draw(names), (name) => {
			const drawnKind = s.draw(kind)
			return {
				name,
				kind: drawnKind,
				env:
					drawnKind !== "mutualTLS" && s.draw(element([0, 1, 2, 3])) === 0
						? Option.some(
								Arr.join(
									Arr.filter(["CUSTOM", screaming(slugOf(name)), "TOKEN"], Str.isNonEmpty),
									"_"
								)
							)
						: Option.none()
			}
		})

const caseGen =
	(
		names: Gen<ReadonlyArray<string>>,
		kind: Gen<Kind>,
		prefix: Gen<Option.Option<string>>,
		strays: Gen<ReadonlyArray<string>>
	): Gen<CredentialCase> =>
	(s) => ({
		schemes: s.draw(schemesGen(names, kind)),
		prefix: s.draw(prefix),
		strays: s.draw(strays)
	})

const anyNames = uniqueKeys(element(NAMES), { min: 1, max: 4 })

const prefixGen = weighted<Option.Option<string>>([
	[2, constant(Option.some("MT"))],
	[1, constant(Option.none())]
])

const noStrays = constant<ReadonlyArray<string>>([])

const someStrays = array(element(["ghost", "missing"]), { min: 0, max: 1 })

const anyCase = caseGen(anyNames, kindGen, prefixGen, someStrays)

const pair = (a: string, b: string, kind: Gen<Kind>): Gen<CredentialCase> =>
	caseGen(constant([a, b]), kind, constant(Option.some("MT")), noStrays)

/** Schemes, aimed at kept and colliding credentials of each kind, empty names, overrides and the bin-name prefix. */
export const credentialSpace: Aimed<CredentialCase, Feature> = aimed(anyCase, [
	[
		"a token kept",
		caseGen(
			constant(["partner"]),
			element<Kind>(["bearer", "basic", "apiKey"]),
			prefixGen,
			noStrays
		)
	],
	[
		"a certificate kept",
		caseGen(constant(["client", "partner"]), constant("mutualTLS"), prefixGen, noStrays)
	],
	[
		"two tokens folding to one env",
		pair("bearerAuth", "bearer_auth", element<Kind>(["bearer", "apiKey"]))
	],
	["two certificates folding to one slug", pair("Client", "client", constant("mutualTLS"))],
	[
		"a certificate env a token also takes",
		(s) => ({
			schemes: [
				{ name: "client", kind: "mutualTLS", env: Option.none() },
				{
					name: "client-cert",
					kind: s.draw(element<Kind>(["bearer", "basic"])),
					env: Option.none()
				}
			],
			prefix: Option.some("MT"),
			strays: []
		})
	],
	...Arr.map(
		[
			["BASE_URL", "baseUrl"],
			["TIMEOUT", "timeout"],
			["IDLE_TIMEOUT", "idleTimeout"],
			["ERROR_FORMAT", "errorFormat"]
		] as const,
		([setting, name]) =>
			[
				`a token env taking ${setting}`,
				caseGen(constant([name]), constant("bearer"), constant(Option.some("MT")), noStrays)
			] as const
	),
	["a name folding to nothing", caseGen(constant(["_", "partner"]), kindGen, prefixGen, noStrays)],
	[
		"a configured env",
		(s) => ({
			schemes: [{ name: "apiKey", kind: "apiKey", env: Option.some("MT_TOKEN") }],
			prefix: Option.some("MT"),
			strays: s.draw(noStrays)
		})
	],
	[
		"an override naming no scheme",
		caseGen(constant(["partner"]), kindGen, prefixGen, constant(["ghost"]))
	],
	[
		"the prefix from the bin name",
		caseGen(constant(["partner"]), kindGen, constant(Option.none()), noStrays)
	]
])
