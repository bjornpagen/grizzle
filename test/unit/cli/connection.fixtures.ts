/** What the properties of connection.test.ts read: its spaces, models and helpers. */

import net from "node:net"
import { inspect } from "node:util"
import { assert, lacksText, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { passed, type Wild, wild, type WildKind } from "@bjornpagen/testing/lsw"
import { Array as Arr, Data, Effect, Redacted, type Result, String as Str } from "effect"
import pgDriver from "pg"
import { type StartupVariable } from "#adapter/connection/environment.ts"
import type { MigrationConnection } from "#adapter/migrate/session.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import type { CliError, Said } from "#cli/errors.ts"
import { refusedAt } from "#test/support/assert.ts"
import { type VariableValue } from "#test/support/process-env.ts"

const caText = "-----BEGIN CERTIFICATE-----\nMIIBconnection\n-----END CERTIFICATE-----\n"

/** Characters a connection string would escape or read specially, and characters outside ASCII. */
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

const textChar: Gen<string> = weighted([
	[3, element(plain)],
	[1, element(tricky)]
])

export const textPart: Gen<string> = map(array(textChar, { min: 1, max: 6 }), (cs) =>
	Arr.join(cs, "")
)

/** The tricky characters a network host may start with: all but /, with which a host is a path. */
const hostHeads = nonEmpty(
	Arr.filter(tricky, (c) => c !== "/"),
	"tricky characters a host may start with"
)

/** Tricky text a network host may be: any characters after its first, which is never the / a path starts with. */
const hostText: Gen<string> = (source) =>
	Arr.join(
		[
			source.draw(
				weighted([
					[3, element(plain)],
					[1, element(hostHeads)]
				])
			),
			...source.draw(array(textChar, { min: 0, max: 5 }))
		],
		""
	)

const label = map(
	array(element(nonEmpty(Str.split("abz09-", ""), "label characters")), { min: 1, max: 5 }),
	(cs) => Arr.join(cs, "")
)

/** IPv6 literals, which a host may be. */
const ipv6Hosts = ["::1", "::", "fe80::1", "2001:db8::42", "::ffff:a00:1"] as const

/** A network host: DNS names, IPv4 and IPv6 literals, and text of tricky characters that is no path. */
const hostGen: Gen<string> = oneOf<string>([
	map(array(label, { min: 1, max: 3 }), (ls) => Arr.join(ls, ".")),
	map(array(int(0, 255), { min: 4, max: 4 }), (ns) =>
		Arr.join(
			Arr.map(ns, (n) => String(n)),
			"."
		)
	),
	element(ipv6Hosts),
	hostText
])

/**
 * A drawn connection's transport: over the network, with its host, servername, CA and password, the password a
 * Redacted or an Effect yielding one; or over a Unix socket, its directory an absolute path of tricky text, with no
 * password.
 */
type DrawnTransport =
	| {
			readonly kind: "sslRequest"
			readonly host: string
			readonly port: number
			readonly servername: string
			readonly ca: "one" | "list"
			readonly passwordForm: "redacted" | "effect"
	  }
	| { readonly kind: "unixSocket"; readonly directory: string; readonly port: number }

/** A drawn connection: its settings, and the password a network transport signs in with. */
interface Drawn {
	readonly role: string
	readonly password: string
	readonly database: string
	readonly transport: DrawnTransport
}

const portGen: Gen<number> = oneOf([element([1, 5432, 65535]), int(1, 65535)])

/** A socket directory: an absolute path of one to three segments of tricky text, a / ending it or not. */
const directoryGen: Gen<string> = (source) =>
	`/${Arr.join(source.draw(array(textPart, { min: 1, max: 3 })), "/")}${source.draw(element(["", "/"]))}`

const transportGen: Gen<DrawnTransport> = oneOf<DrawnTransport>([
	(source) => ({
		kind: "sslRequest",
		host: source.draw(hostGen),
		port: source.draw(portGen),
		servername: source.draw(oneOf([hostGen, textPart])),
		ca: source.draw(element(["one", "list"])),
		passwordForm: source.draw(element(["redacted", "effect"]))
	}),
	(source) => ({
		kind: "unixSocket",
		directory: source.draw(directoryGen),
		port: source.draw(portGen)
	})
])

export const drawnGen: Gen<Drawn> = (source) => ({
	role: source.draw(textPart),
	/** Distinctive, so a reason quoting it is caught. */
	password: source.draw(map(textPart, (p) => `pw-${p}`)),
	database: source.draw(textPart),
	transport: source.draw(transportGen)
})

const open = (): net.Socket => new net.Socket()

/**
 * The configuration's connection of a drawn one: over the network its password one object a resolved connection keeps;
 * over a Unix socket none.
 */
export const typedOf = (d: Drawn): MigrationConnectionConfig => {
	const target = { driver: pgDriver, database: d.database, role: d.role }
	const t = d.transport
	switch (t.kind) {
		case "sslRequest":
			return {
				...target,
				transport: {
					kind: "sslRequest",
					host: t.host,
					port: t.port,
					open,
					ca: t.ca === "one" ? caText : [caText, caText],
					servername: t.servername
				},
				password:
					t.passwordForm === "redacted"
						? Redacted.make(d.password)
						: Effect.sync(() => Redacted.make(d.password))
			}
		case "unixSocket":
			return {
				...target,
				transport: { kind: "unixSocket", directory: t.directory, port: t.port }
			}
	}
}

/**
 * A transport's settings the agreement compares: over the network, whether its password and `open` are the given ones;
 * over a Unix socket, its directory and port, and nothing more, since it holds no credential.
 */
type TransportFields =
	| {
			readonly kind: "sslRequest"
			readonly host: string
			readonly port: number
			readonly ca: ReadonlyArray<string>
			readonly servername: string
			readonly open: boolean
			readonly password: boolean
	  }
	| { readonly kind: "unixSocket"; readonly directory: string; readonly port: number }

/** The settings the agreement compares, and whether the driver's three classes are the given ones. */
interface Fields {
	readonly role: string
	readonly database: string
	readonly driver: boolean
	readonly transport: TransportFields
}

/** What a resolved connection must state of the configuration's: every setting, the password and functions as given. */
export const fields = (c: MigrationConnection, given: MigrationConnectionConfig): Fields => ({
	role: c.role,
	database: c.database,
	driver:
		c.driver.Client === given.driver.Client &&
		c.driver.Pool === given.driver.Pool &&
		c.driver.DatabaseError === given.driver.DatabaseError,
	transport: resolvedTransport(c, given)
})

/** A resolved connection's transport fields, `open` and the password compared with the given ones by identity. */
const resolvedTransport = (
	c: MigrationConnection,
	given: MigrationConnectionConfig
): TransportFields => {
	const t = c.transport
	switch (t.kind) {
		case "sslRequest":
			return {
				kind: "sslRequest",
				host: t.host,
				port: t.port,
				ca: t.ca,
				servername: t.servername,
				open: given.transport.kind === "sslRequest" && t.open === given.transport.open,
				password: t.password === given.password
			}
		case "unixSocket":
			return { kind: "unixSocket", directory: t.directory, port: t.port }
	}
}

/** What the configuration states, its CA as the bundle TLS is handed: one PEM text the bundle of it alone. */
export const givenFields = (given: MigrationConnectionConfig): Fields => ({
	role: given.role,
	database: given.database,
	driver: true,
	transport: givenTransport(given.transport)
})

const givenTransport = (t: MigrationConnectionConfig["transport"]): TransportFields => {
	switch (t.kind) {
		case "sslRequest":
			return {
				kind: "sslRequest",
				host: t.host,
				port: t.port,
				ca: typeof t.ca === "string" ? [t.ca] : t.ca,
				servername: t.servername,
				open: true,
				password: true
			}
		case "unixSocket":
			return { kind: "unixSocket", directory: t.directory, port: t.port }
	}
}

/** The shapes the agreement must reach in every run, each by some case. */
export const connectionFeatures = [
	"an IPv6 host",
	"a role outside ASCII",
	"a password Effect",
	"a CA list",
	"the highest port",
	"a Unix socket"
] as const

export type ConnectionFeature = (typeof connectionFeatures)[number]

/** The shapes a drawn connection holds: a code unit past U+007F is a letter outside ASCII, or half a surrogate pair. */
export const notes = (d: Drawn): ReadonlyArray<ConnectionFeature> => {
	const t = d.transport
	return Arr.flatMap(
		[
			["an IPv6 host", t.kind === "sslRequest" && Arr.some(ipv6Hosts, (h) => h === t.host)],
			["a role outside ASCII", Arr.some(Str.split(d.role, ""), (unit) => unit > "\u007f")],
			["a password Effect", t.kind === "sslRequest" && t.passwordForm === "effect"],
			["a CA list", t.kind === "sslRequest" && t.ca === "list"],
			["the highest port", t.port === 65535],
			["a Unix socket", t.kind === "unixSocket"]
		] satisfies ReadonlyArray<readonly [ConnectionFeature, boolean]>,
		([feature, holds]) => (holds ? [feature] : [])
	)
}

/** Everything a refusal reports: its message and the whole error, where no value it refuses may appear. */
export const reported = (refused: CliError): string =>
	`${refused.message}\n${inspect(refused, { depth: 12 })}`

/** A role fault: the empty role, a value of another kind (the library's wild values that are no text), or none. */
type RoleFault =
	| { readonly kind: "the empty role" }
	| { readonly kind: "a role of another kind"; readonly wild: Wild }
	| { readonly kind: "no role" }

export type RoleFaultKind = RoleFault["kind"]

export const roleFaultKinds: Arr.NonEmptyReadonlyArray<RoleFaultKind> = [
	"the empty role",
	"a role of another kind",
	"no role"
]

/** The wild kinds that are no text and are read as data: a role of another kind than a string. */
const otherKinds: Arr.NonEmptyReadonlyArray<WildKind> = [
	"null",
	"undefined",
	"negative-zero",
	"nan",
	"infinity",
	"bigint-for-number",
	"number-for-bigint",
	"symbol",
	"function"
]

export const roleFaultGen: Gen<RoleFault> = oneOf<RoleFault>([
	constant({ kind: "the empty role" }),
	map(wild(otherKinds), (drawnWild) => ({ kind: "a role of another kind", wild: drawnWild })),
	constant({ kind: "no role" })
])

/** The role a fault hands the parse, as JavaScript would. */
const roleOf = (f: Exclude<RoleFault, { readonly kind: "no role" }>): unknown =>
	f.kind === "the empty role" ? "" : passed({ kind: "wild", wild: f.wild })

/** The configuration's connection of `d` with the role fault `f`, as JavaScript would hand it over. */
export const faulty = (d: Drawn, f: RoleFault): MigrationConnectionConfig => {
	const typed = { ...typedOf(d) }
	if (f.kind === "no role") {
		Reflect.deleteProperty(typed, "role")
		return typed
	}
	return Object.assign(typed, { role: roleOf(f) })
}

/** The refusal of a role fault: at stage config, naming the configuration's connection.role, the password unquoted. */
export const roleRefusal = (
	r: Result.Result<MigrationConnection, CliError>,
	password: string
): void => {
	const refused = refusedAt(r, "stage", "config")
	const reason = refused.reason
	if (reason._tag !== "ConnectionRefused") {
		return assert.fail(`the role's refusal is a ConnectionRefused, not ${reason._tag}`)
	}
	assert.deepEqual(
		{ setting: reason.setting, rule: reason.rule },
		{ setting: ["connection", "role"], rule: { kind: "nonemptyText" } },
		"the role's refusal names connection.role as no nonempty string"
	)
	lacksText(reported(refused), password, "the refusal holds the password")
}

/** What a connection function throws, each holding the password, as an application's code may. */
export const thrownKinds = [
	"an Error",
	"a tagged error",
	"a value that is no Error",
	"an Error whose message throws"
] as const

export type ThrownKind = (typeof thrownKinds)[number]

/** An application's own refusal, as Effect.runSync throws a failed Effect's error: its message, the password Redacted. */
class SettingMissing extends Data.TaggedError("SettingMissing")<{
	readonly said: string
	readonly password: Redacted.Redacted
}> {
	override get message(): string {
		return this.said
	}
}

/** What a connection function of `kind` throws, saying `said` and holding `password`, and what a refusal states of it. */
interface ThrownCase {
	readonly value: unknown
	readonly said: Said
}

export const thrownCase = (kind: ThrownKind, said: string, password: string): ThrownCase => {
	switch (kind) {
		case "an Error": {
			const error = Object.assign(new Error(said), { password })
			return { value: error, said: { kind: "error", name: error.name, message: said } }
		}
		case "a tagged error": {
			const error = new SettingMissing({ said, password: Redacted.make(password) })
			return { value: error, said: { kind: "error", name: error.name, message: said } }
		}
		case "a value that is no Error":
			return { value: { message: said, password }, said: { kind: "noError" } }
		case "an Error whose message throws":
			return {
				value: Object.defineProperty(new Error(said), "message", {
					get: () => {
						throw new Error(password)
					}
				}),
				said: { kind: "unreadable" }
			}
	}
}

/** A drawn process environment: each startup variable's value. */
export type OwnerEnvironment = { readonly [V in StartupVariable]: VariableValue }

/** What a run of the owner environment property reaches. */
export type OwnerEnvironmentFeature =
	| "refused PGREPLICATION"
	| "refused PGREPLICATION beside PGOPTIONS set"
	| "admitted with PGOPTIONS set"
	| "admitted with a variable empty"
	| "admitted with neither set"
