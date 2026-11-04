import { rootCertificates } from "node:tls"
import { inspect } from "node:util"
import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Option,
	pipe,
	Record as Rec,
	Redacted,
	type Result,
	String as Str
} from "effect"
import { type StartupVariable, startupVariableNames } from "#adapter/connection/environment.ts"
import { ConnectionEnvironmentRefused } from "#adapter/errors/failures.ts"
import type { MigrationConnection } from "#adapter/migrate/session.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import {
	type ConnectionEnv,
	ownerEnvironment,
	parseDatabaseUrl,
	resolveConnection
} from "#cli/connection.ts"
import type { CliError } from "#cli/errors.ts"
import { assert, lacksText, nonEmpty, refusedAt, succeeded } from "#test/support/assert.ts"
import {
	processEnvironment,
	processValue,
	valueMark,
	type VariableValue,
	variableGen
} from "#test/support/process-env.ts"

import { regex } from "arkregex"
/**
 * Where `grizzle migrate` connects, generated: DATABASE_URL and the configuration's typed connection describe the same
 * connections, and refuse the same faults.
 *
 * - Agreement with a model: a connection drawn with tricky parts (reserved and non-ASCII characters in the role,
 *   password, database and host, IPv6 hosts, ports from 0 to past 65535) is written once as DATABASE_URL, its parts
 *   percent-encoded and a default port sometimes left out, and once as a typed connection. Both are accepted with
 *   exactly the drawn host, port, database, role and password when every part is nonempty and the port is from 1 to
 *   65535, and both are refused at stage config otherwise.
 * - The URL's password, else PGPASSWORD's; the CA that sslrootcert names, else PGSSLROOTCERT's, else the system trust
 *   store, which `system` also names; a relative path resolves against the directory grizzle runs in.
 * - Faults: one fault injected into an accepted connection, URL or typed, is refused at stage config, and no refusal
 *   holds the password, raw or percent-encoded, in its message or anywhere else.
 * - The process environment, the one node-postgres reads: drawn with `PGOPTIONS` and `PGREPLICATION` each absent, empty
 *   or at a text, a migration's is refused at stage config exactly when one holds a text, with a
 *   ConnectionEnvironmentRefused naming the first of them and quoting no value, since an owner's session sets no
 *   options of its own and pg would send both at its startup.
 */
const caText = "-----BEGIN CERTIFICATE-----\nMIIBurl\n-----END CERTIFICATE-----\n"
const envCaText = "-----BEGIN CERTIFICATE-----\nMIIBenvironment\n-----END CERTIFICATE-----\n"

/** The directory grizzle runs in, with the CA files the cases name, removed when the test's scope closes. */
const caDirectory = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-connection-" })
	yield* fs.writeFileString(`${cwd}/root.pem`, caText)
	yield* fs.writeFileString(`${cwd}/env.pem`, envCaText)
	yield* fs.writeFileString(`${cwd}/empty.pem`, " \n")
	return cwd
})

/** Characters a URL must escape or reads specially, and characters outside ASCII. */
const tricky: Arr.NonEmptyReadonlyArray<string> = [
	"@",
	":",
	"/",
	"?",
	"#",
	"%",
	" ",
	"&",
	"=",
	"+",
	"'",
	'"',
	"\\",
	"[",
	"]",
	"é",
	"ß",
	"語",
	"😀"
]
const plain = nonEmpty(Str.split("abcxyz019_-.", ""), "plain characters")
const textPart = (minLength: number): Gen<string> =>
	map(
		array(
			weighted([
				[3, element(plain)],
				[1, element(tricky)]
			]),
			{ min: minLength, max: 6 }
		),
		(cs) => Arr.join(cs, "")
	)

interface Host {
	readonly ipv6: boolean
	readonly name: string
}

const label = map(
	array(element(nonEmpty(Str.split("abz09-", ""), "label characters")), { min: 1, max: 5 }),
	(cs) => Arr.join(cs, "")
)

/** Canonical forms, as the URL parser writes them back. */
const hostGen: Gen<Host> = oneOf<Host>([
	map(array(label, { min: 1, max: 3 }), (ls) => ({ ipv6: false, name: Arr.join(ls, ".") })),
	map(array(int(0, 255), { min: 4, max: 4 }), (ns) => ({
		ipv6: false,
		name: Arr.join(
			Arr.map(ns, (n) => String(n)),
			"."
		)
	})),
	map(element(["::1", "::", "fe80::1", "2001:db8::42", "::ffff:a00:1"]), (name) => ({
		ipv6: true,
		name
	})),
	map(textPart(1), (name) => ({ ipv6: false, name }))
])

type UrlCa = "none" | "system" | "absolute" | "relative"
interface Drawn {
	readonly role: string
	readonly password: string
	readonly host: Host
	readonly port: number
	readonly database: string
	/** The URL leaves out a port of 5432. */
	readonly defaultPort: boolean
	/** The password comes from PGPASSWORD rather than the URL. */
	readonly passwordFromEnv: boolean
	readonly sslmode: boolean
	readonly urlCa: UrlCa
	readonly envCa: boolean
}

/** A URL's path normalizes the dot segments away, so no URL names a database "." or "..". */
const databasePart = (minLength: number): Gen<string> =>
	filter(textPart(minLength), (name) => name !== "." && name !== "..", 100)

const drawnGen =
	(minLength: number): Gen<Drawn> =>
	(source) => ({
		role: source.draw(textPart(minLength)),
		/** Distinctive, so a reason quoting it is caught. */
		password: source.draw(map(textPart(2), (p) => `pw-${p}`)),
		host: source.draw(hostGen),
		port: source.draw(oneOf([element([0, 1, 5432, 65535, 65536, 70000]), int(1, 65535)])),
		database: source.draw(databasePart(minLength)),
		defaultPort: source.draw(boolean),
		passwordFromEnv: source.draw(boolean),
		sslmode: source.draw(boolean),
		urlCa: source.draw(element<UrlCa>(["none", "system", "absolute", "relative"])),
		envCa: source.draw(boolean)
	})

const valid = (d: Drawn): boolean =>
	d.role.length > 0 && d.database.length > 0 && d.port >= 1 && d.port <= 65535
const validGen = filter(drawnGen(1), valid, 100)

/** A DATABASE_URL by its parts, each already written as the URL holds it. */
interface UrlParts {
	readonly scheme: string
	readonly userinfo: string
	readonly host: string
	readonly port: string
	readonly path: string
	readonly params: ReadonlyArray<string>
	readonly fragment: string
	readonly env: Readonly<Record<string, string>>
}

const caPath = (cwd: string, ca: UrlCa): string =>
	ca === "absolute" ? `${cwd}/root.pem` : ca === "relative" ? "root.pem" : ca

/** The parts of the URL that writes `d`, its CA files in `cwd`. */
const partsOf = (cwd: string, d: Drawn): UrlParts => ({
	scheme: "postgresql",
	userinfo: `${encodeURIComponent(d.role)}${d.passwordFromEnv ? "" : `:${encodeURIComponent(d.password)}`}@`,
	host: d.host.ipv6 ? `[${d.host.name}]` : encodeURIComponent(d.host.name),
	port: d.defaultPort && d.port === 5432 ? "" : `:${d.port}`,
	path: `/${encodeURIComponent(d.database)}`,
	params: [
		...(d.sslmode ? ["sslmode=verify-full"] : []),
		...(d.urlCa === "none" ? [] : [`sslrootcert=${encodeURIComponent(caPath(cwd, d.urlCa))}`])
	],
	fragment: "",
	env: {
		...(d.passwordFromEnv ? { PGPASSWORD: d.password } : {}),
		...(d.envCa ? { PGSSLROOTCERT: `${cwd}/env.pem` } : {})
	}
})

const urlOf = (p: UrlParts): string =>
	`${p.scheme}://${p.userinfo}${p.host}${p.port}${p.path}${p.params.length === 0 ? "" : `?${Arr.join(p.params, "&")}`}${p.fragment}`

const expectedCa = (d: Drawn): string | ReadonlyArray<string> =>
	d.urlCa === "absolute" || d.urlCa === "relative"
		? caText
		: d.urlCa === "system" || !d.envCa
			? [...rootCertificates]
			: envCaText

const typedOf = (d: Drawn): MigrationConnectionConfig => ({
	host: d.host.name,
	port: d.port,
	database: d.database,
	role: d.role,
	password: Redacted.make(d.password),
	tls: { ca: expectedCa(d) }
})

/** The fields both paths must agree on. */
const fields = (c: MigrationConnection) => ({
	host: c.host,
	port: c.port,
	database: c.database,
	role: c.role,
	password: Redacted.isRedacted(c.password) ? Redacted.value(c.password) : "<an Effect>",
	ca: c.tls.ca,
	servername: c.tls.servername
})

const drawnFields = (d: Drawn) => ({
	host: d.host.name,
	port: d.port,
	database: d.database,
	role: d.role,
	password: d.password,
	ca: expectedCa(d),
	/** Neither path names a servername, so both verify the host. */
	servername: d.host.name
})

/** The shapes the agreement must reach in every run, each by some case. */
const connectionFeatures = [
	"a host only percent-encoding writes",
	"an IPv6 host",
	"a database holding a slash",
	"a role outside ASCII",
	"port 0",
	"a port past 65535",
	"the default port left out",
	"the password from PGPASSWORD",
	"the CA from PGSSLROOTCERT",
	"the system trust store over PGSSLROOTCERT",
	"a relative sslrootcert",
	"an empty role or database"
] as const
type ConnectionFeature = (typeof connectionFeatures)[number]

/**
 * The shapes a drawn connection holds.
 *
 * A code unit past U+007F: a letter outside ASCII, or the first half of a surrogate pair.
 */
const notes = (d: Drawn): ReadonlyArray<ConnectionFeature> =>
	Arr.flatMap(
		[
			[
				"a host only percent-encoding writes",
				!d.host.ipv6 && encodeURIComponent(d.host.name) !== d.host.name
			],
			["an IPv6 host", d.host.ipv6],
			["a database holding a slash", Str.includes("/")(d.database)],
			["a role outside ASCII", Arr.some(Str.split(d.role, ""), (unit) => unit > "\u007f")],
			["port 0", d.port === 0],
			["a port past 65535", d.port > 65535],
			["the default port left out", d.defaultPort && d.port === 5432],
			["the password from PGPASSWORD", d.passwordFromEnv],
			["the CA from PGSSLROOTCERT", d.urlCa === "none" && d.envCa],
			["the system trust store over PGSSLROOTCERT", d.urlCa === "system" && d.envCa],
			["a relative sslrootcert", d.urlCa === "relative"],
			["an empty role or database", d.role === "" || d.database === ""]
		] satisfies ReadonlyArray<readonly [ConnectionFeature, boolean]>,
		([feature, holds]) => (holds ? [feature] : [])
	)

/** A connection on port 0, which the URL path once accepted. */
const keptAgreement: ReadonlyArray<Kept<Drawn, ConnectionFeature>> = [
	{
		note: "port 0 accepted",
		draws: "",
		sketch: {
			role: "a",
			password: "pw-aa",
			host: { ipv6: false, name: "a" },
			port: 0,
			database: "a",
			defaultPort: false,
			passwordFromEnv: false,
			sslmode: false,
			urlCa: "none",
			envCa: false
		},
		reaches: ["port 0"]
	}
]

/** Everything a refusal reports: its message and the whole error, where no value it refuses may appear. */
const reported = (refused: CliError): string =>
	`${refused.message}\n${inspect(refused, { depth: 12 })}`

/** A refusal at stage config, which never holds the password: not in its message, nor anywhere in the error. */
const refusal = (r: Result.Result<MigrationConnection, CliError>, password: string): void => {
	const refused = refusedAt(r, "stage", "config")
	for (const quoted of [password, encodeURIComponent(password)]) {
		lacksText(reported(refused), quoted, "the refusal holds the password")
	}
}

/** The kinds of a URL's fault: a weak sslmode, an unknown parameter, and the rest by the part they break. */
const urlFaultKinds = [
	"sslmode",
	"parameter",
	"fragment",
	"percent-encoding in its role",
	"percent-encoding in its password",
	"percent-encoding in its database",
	"percent-encoding in its host",
	"must start with postgresql://",
	"is not a URL",
	"names no role",
	"names no database",
	"port",
	"does not exist",
	"holds no certificate"
] as const
type UrlFaultKind = (typeof urlFaultKinds)[number]

/** One fault of a URL: the text and environment it gives, and its kind. */
interface UrlFault {
	readonly url: string
	readonly env: Readonly<Record<string, string>>
	readonly kind: UrlFaultKind
}

const urlFault = (parts: UrlParts, kind: UrlFaultKind): UrlFault => ({
	url: urlOf(parts),
	env: parts.env,
	kind
})
const withParam = (p: UrlParts, param: string): UrlParts => ({ ...p, params: [...p.params, param] })
const withCa = (p: UrlParts, file: string): UrlParts => ({
	...p,
	params: [
		...Arr.filter(p.params, (x) => !Str.startsWith("sslrootcert=")(x)),
		`sslrootcert=${file}`
	]
})

const urlFaults = (cwd: string, d: Drawn): Gen<UrlFault> => {
	/** An IPv6 literal admits no percent-encoding at all. */
	const p = partsOf(cwd, d)
	return oneOf([
		map(element(["disable", "allow", "prefer", "require", "verify-ca"]), (mode) =>
			urlFault(withParam(p, `sslmode=${mode}`), "sslmode")
		),
		map(element(["connect_timeout", "application_name", "sslMode", "sslcert"]), (key) =>
			urlFault(withParam(p, `${key}=1`), "parameter")
		),
		constant(urlFault({ ...p, fragment: "#main" }, "fragment")),
		constant(
			urlFault(
				{ ...p, userinfo: Str.replace(regex("^([^:@]*)"), "$1%zz")(p.userinfo) },
				"percent-encoding in its role"
			)
		),
		constant(
			urlFault(
				{
					...p,
					userinfo: `${Str.slice(0, -1)(p.userinfo)}${d.passwordFromEnv ? ":" : ""}%E0%A4%A@`
				},
				"percent-encoding in its password"
			)
		),
		constant(
			d.host.ipv6
				? urlFault({ ...p, path: `${p.path}%zz` }, "percent-encoding in its database")
				: urlFault({ ...p, host: `${p.host}%zz` }, "percent-encoding in its host")
		),
		constant(urlFault({ ...p, path: `${p.path}%zz` }, "percent-encoding in its database")),
		map(element(["mysql", "jdbc", "postgresql+psycopg", "postgre"]), (scheme) =>
			urlFault({ ...p, scheme }, "must start with postgresql://")
		),
		constant<UrlFault>({
			url: pipe(urlOf(p), Str.slice("postgresql:".length)),
			env: p.env,
			kind: "is not a URL"
		}),
		constant(urlFault({ ...p, userinfo: "" }, "names no role")),
		map(element(["/", `${p.path}/extra`]), (path) => urlFault({ ...p, path }, "names no database")),
		constant(urlFault({ ...p, port: ":0" }, "port")),
		constant(urlFault(withCa(p, "missing.pem"), "does not exist")),
		constant(
			urlFault(
				{
					...p,
					params: Arr.filter(p.params, (x) => !Str.startsWith("sslrootcert=")(x)),
					env: { ...p.env, PGSSLROOTCERT: `${cwd}/missing.pem` }
				},
				"does not exist"
			)
		),
		constant(urlFault(withCa(p, "empty.pem"), "holds no certificate"))
	])
}

/** One fault of a typed connection: the settings it overrides with values the type would refuse. */
interface TypedFault {
	readonly override: Readonly<Record<string, unknown>>
	readonly tls: Readonly<Record<string, unknown>>
}

const fault = (
	override: Readonly<Record<string, unknown>>,
	tls: Readonly<Record<string, unknown>>
): TypedFault => ({
	override,
	tls
})

const typedFaults: Gen<TypedFault> = oneOf([
	map(element(["sslmode", "user", "ssl", "options"]), (key) => fault({ [key]: "x" }, {})),
	(source) => {
		const key = source.draw(element(["host", "database", "role"]))
		return fault({ [key]: source.draw(element<unknown>(["", 1, undefined, null])) }, {})
	},
	map(element<unknown>([0, 65536, 54.32, "5432", Number.NaN, undefined]), (port) =>
		fault({ port }, {})
	),
	map(element<unknown>(["plain text", undefined, 42, { value: "x" }]), (password) =>
		fault({ password }, {})
	),
	map(element<unknown>([undefined, "verify-full", null]), (tls) => fault({ tls }, {})),
	map(element(["mode", "sslmode", "rejectUnauthorized"]), (key) => fault({}, { [key]: "x" })),
	map(element<unknown>(["", [], [""], 42, undefined]), (ca) => fault({}, { ca })),
	map(element<unknown>(["", 7]), (servername) => fault({}, { servername }))
])

/** A URL on port 0. */
const keptUrlFaults: ReadonlyArray<Kept<readonly [Drawn, UrlFault], UrlFaultKind>> = [
	{
		note: "a URL's port 0 accepted",
		draws: "",
		sketch: [
			{
				role: "-1y..",
				password: "pw-za",
				host: { ipv6: false, name: "170.169.250.4" },
				port: 65527,
				database: "語-]c_",
				defaultPort: false,
				passwordFromEnv: true,
				sslmode: false,
				urlCa: "system",
				envCa: false
			},
			{
				url: "postgresql://-1y..@170.169.250.4:0/%E8%AA%9E-%5Dc_?sslrootcert=system",
				env: { PGPASSWORD: "pw-za" },
				kind: "port"
			}
		],
		reaches: ["port"]
	}
]

/** The environment of a case: its PGPASSWORD and PGSSLROOTCERT, no DATABASE_URL (the URL is the case's). */
const envOf = (env: Readonly<Record<string, string>>): ConnectionEnv => ({
	DATABASE_URL: Option.none(),
	PGPASSWORD: Option.filter(Option.fromUndefinedOr(env["PGPASSWORD"]), Str.isNonEmpty),
	PGSSLROOTCERT: Option.filter(Option.fromUndefinedOr(env["PGSSLROOTCERT"]), Str.isNonEmpty)
})

/** A DATABASE_URL parsed in `cwd`, its CA files read through Node's FileSystem. */
const parsedUrl = (cwd: string, url: string, env: Readonly<Record<string, string>>) =>
	Effect.result(parseDatabaseUrl(url, envOf(env), cwd))

layer(NodeServices.layer, { excludeTestServices: true })(
	"DATABASE_URL and the typed connection, generated",
	(it) => {
		it.effect("agree with the model on every drawn connection", (ctx) =>
			Effect.gen(function* () {
				const cwd = yield* caDirectory
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/cli/connection-agreement",
							draw: drawn(drawnGen(0)),
							literal: Formatter.format,
							coverage: required<ConnectionFeature>(connectionFeatures, {
								cases: 300,
								sense: notesOnly
							}),
							kept: keptAgreement,
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.millis(5000)
						},
						(d, c) =>
							Effect.gen(function* () {
								c.noteAll(notes(d))
								const p = partsOf(cwd, d)
								const url = urlOf(p)
								const parsed = yield* parsedUrl(cwd, url, p.env)
								const typed = resolveConnection(typedOf(d))
								if (valid(d)) {
									assert.deepEqual(fields(succeeded(parsed, url)), drawnFields(d), url)
									assert.deepEqual(fields(succeeded(typed, "the typed connection")), drawnFields(d))
								} else {
									refusal(parsed, d.password)
									refusal(typed, d.password)
								}
							})
					)
				)
			})
		)

		it.effect(
			"refuse every fault injected into an accepted URL at stage config, never quoting the password",
			(ctx) =>
				Effect.gen(function* () {
					const cwd = yield* caDirectory
					yield* searched(
						ctx,
						explore(
							{
								suite: "unit/cli/connection-url-faults",
								draw: drawn((source): readonly [Drawn, UrlFault] => {
									const d = source.draw(validGen)
									return [d, source.draw(urlFaults(cwd, d))]
								}),
								literal: Formatter.format,
								coverage: required<UrlFaultKind>(urlFaultKinds, { cases: 300, sense: notesOnly }),
								kept: keptUrlFaults,
								runs: 300,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang: Duration.millis(5000)
							},
							([d, f], c) =>
								Effect.map(parsedUrl(cwd, f.url, f.env), (parsed) => {
									c.note(f.kind)
									refusal(parsed, d.password)
								})
						)
					)
				})
		)
	}
)

describe("the typed connection, generated", () => {
	it.effect(
		"refuse every fault injected into an accepted typed connection at stage config, never quoting the password",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/connection-typed-faults",
						draw: drawn((source) => [source.draw(validGen), source.draw(typedFaults)] as const),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([d, f]) =>
						Effect.sync(() => {
							const base = typedOf(d)
							/** A fault that replaces tls whole leaves no tls object to extend. */
							const typed: MigrationConnectionConfig = Rec.has(f.override, "tls")
								? Object.assign({ ...base }, f.override)
								: Object.assign({ ...base }, f.override, {
										tls: Object.assign({ ...base.tls }, f.tls)
									})
							refusal(resolveConnection(typed), d.password)
						})
				)
			)
	)
})

/** A drawn process environment: each startup variable's value. */
type OwnerEnvironment = { readonly [V in StartupVariable]: VariableValue }

/** What a run of the owner environment property reaches. */
type OwnerEnvironmentFeature =
	| `refused ${StartupVariable}`
	| "refused PGOPTIONS beside PGREPLICATION set"
	| "admitted with a variable empty"
	| "admitted with neither set"

describe("the migration's process environment, generated", () => {
	it.effect(
		"refuses at stage config exactly the environments that set PGOPTIONS or PGREPLICATION, naming the first",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/owner-environment",
						draw: drawn((source): OwnerEnvironment => ({
							PGOPTIONS: source.draw(variableGen),
							PGREPLICATION: source.draw(variableGen)
						})),
						literal: Formatter.format,
						coverage: required<OwnerEnvironmentFeature>(
							[
								"refused PGOPTIONS",
								"refused PGREPLICATION",
								"refused PGOPTIONS beside PGREPLICATION set",
								"admitted with a variable empty",
								"admitted with neither set"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(e, c) =>
						Effect.gen(function* () {
							const result = yield* Effect.scoped(
								Effect.andThen(
									processEnvironment(
										Rec.fromEntries(
											Arr.map(
												startupVariableNames,
												(name) => [name, processValue(e[name])] as const
											)
										)
									),
									Effect.result(ownerEnvironment)
								)
							)
							const expected = Arr.findFirst(
								startupVariableNames,
								(name) => e[name].kind === "text"
							)
							if (Option.isNone(expected)) {
								succeeded(result, "an environment that sets neither variable")
								c.note(
									Arr.some(startupVariableNames, (name) => e[name].kind === "empty")
										? "admitted with a variable empty"
										: "admitted with neither set"
								)
								return
							}
							const refused = refusedAt(result, "stage", "config")
							assert.ok(
								refused.reason instanceof ConnectionEnvironmentRefused,
								`the environment's refusal is ${refused.reason._tag}`
							)
							assert.equal(refused.reason.variable, expected.value)
							lacksText(reported(refused), valueMark, "the refusal holds a value")
							c.note(`refused ${expected.value}`)
							if (expected.value === "PGOPTIONS" && e.PGREPLICATION.kind === "text") {
								c.note("refused PGOPTIONS beside PGREPLICATION set")
							}
						})
				)
			)
	)
})
