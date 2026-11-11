import net from "node:net"
import { inspect } from "node:util"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf, weighted } from "@grizzle/testing/gen"
import { passed, type Wild, type WildKind, wild } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Redacted,
	type Result,
	String as Str
} from "effect"
import pgDriver from "pg"
import { timerMaxMs } from "#adapter/connection/config.ts"
import { type StartupVariable, startupVariableNames } from "#adapter/connection/environment.ts"
import { ConnectionEnvironmentRefused } from "#adapter/errors/failures.ts"
import type { MigrationConnection } from "#adapter/migrate/session.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import { calledConnection, ownerEnvironment, resolveConnection } from "#cli/connection.ts"
import type { CliError, Said } from "#cli/errors.ts"
import { assert, lacksText, nonEmpty, refusedAt, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	processEnvironment,
	processValue,
	valueMark,
	type VariableValue,
	variableGen
} from "#test/support/process-env.ts"

/**
 * Where `grizzle migrate` and `grizzle drift` connect, generated: the configuration's connection, and nothing else.
 *
 * - Agreement: a connection drawn with tricky parts (reserved and non-ASCII characters in the role, password, database,
 *   host and servername, the host never a path, IPv6 hosts, ports and timeouts across their ranges, a CA as one text or
 *   a list, a password Redacted or an Effect) resolves to exactly the drawn role and connection, its CA the bundle TLS
 *   is handed: the parse of the connection (adapter/connection/config.ts, whose faults test/unit/adapter/layer.test.ts
 *   injects through DbLayer.make) plus the role and the password kept as given, and the driver as the three classes
 *   it reads off the given module once (its Client, Pool and DatabaseError), never the module itself, so no getter of
 *   another member runs.
 * - The role, the one setting a migration connection adds: one that is not a nonempty string, or none, is refused at
 *   stage config as a ConnectionRefused whose setting is `["connection", "role"]` and whose rule is a nonempty string
 *   (SettingFault), and no refusal holds the password.
 * - A connection function that throws (an Error, an application's tagged error holding the password Redacted, a value
 *   that is no Error, an Error whose message throws when read), each holding the password, is refused at stage config
 *   as ConnectionThrew, which holds exactly what was thrown, Redacted, and states of it exactly an Error's name and
 *   message, nothing of a value that is no Error, and an unreadable message as unreadable: so it states no password.
 * - The process environment, the one node-postgres reads: drawn with `PGOPTIONS` and `PGREPLICATION` each absent, empty
 *   or at a text, a migration's is refused at stage environment exactly when one holds a text, with a
 *   ConnectionEnvironmentRefused naming the first of them and quoting no value, since an owner's session sets no
 *   options of its own and pg would send both at its startup.
 *
 * Oracles: the drawn connection itself, the role and password as given and the parse's fields (agreement); the
 * specification of each refusal, its stage, reason and named setting, over the role faults, the thrown values and the
 * environments drawn.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): connection-empty-role.patch (an empty role is admitted),
 * connection-owner-options.patch (an owner's environment is refused only for PGREPLICATION).
 *
 * Features: the connection's tricky shapes, each role fault, each thrown value, and each environment's verdict.
 */
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
const textPart: Gen<string> = map(array(textChar, { min: 1, max: 6 }), (cs) => Arr.join(cs, ""))

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

/** A drawn connection: its settings, the password as a Redacted or an Effect yielding one. */
interface Drawn {
	readonly role: string
	readonly password: string
	readonly passwordForm: "redacted" | "effect"
	readonly host: string
	readonly port: number
	readonly servername: string
	readonly ca: "one" | "list"
	readonly database: string
	readonly connectTimeoutMs: number
}

const drawnGen: Gen<Drawn> = (source) => ({
	role: source.draw(textPart),
	/** Distinctive, so a reason quoting it is caught. */
	password: source.draw(map(textPart, (p) => `pw-${p}`)),
	passwordForm: source.draw(element(["redacted", "effect"])),
	host: source.draw(hostGen),
	port: source.draw(oneOf([element([1, 5432, 65535]), int(1, 65535)])),
	servername: source.draw(oneOf([hostGen, textPart])),
	ca: source.draw(element(["one", "list"])),
	database: source.draw(textPart),
	connectTimeoutMs: source.draw(oneOf([element([1, timerMaxMs.value]), int(1, timerMaxMs.value)]))
})

const open = (): net.Socket => new net.Socket()

/** The configuration's connection of a drawn one, its password one object a resolved connection keeps. */
const typedOf = (d: Drawn): MigrationConnectionConfig => ({
	driver: pgDriver,
	transport: {
		kind: "sslRequest",
		host: d.host,
		port: d.port,
		open,
		ca: d.ca === "one" ? caText : [caText, caText],
		servername: d.servername
	},
	database: d.database,
	role: d.role,
	password:
		d.passwordForm === "redacted"
			? Redacted.make(d.password)
			: Effect.sync(() => Redacted.make(d.password)),
	connectTimeoutMs: d.connectTimeoutMs
})

/**
 * The settings the agreement compares, and whether the password, the driver's three classes and `open` are the given
 * ones.
 */
interface Fields {
	readonly role: string
	readonly database: string
	readonly connectTimeoutMs: number
	readonly kind: "sslRequest"
	readonly host: string
	readonly port: number
	readonly ca: ReadonlyArray<string>
	readonly servername: string
	readonly driver: boolean
	readonly open: boolean
	readonly password: boolean
}

/** What a resolved connection must state of the configuration's: every setting, the password and functions as given. */
const fields = (c: MigrationConnection, given: MigrationConnectionConfig): Fields => ({
	role: c.role,
	database: c.database,
	connectTimeoutMs: c.connectTimeoutMs,
	kind: c.transport.kind,
	host: c.transport.host,
	port: c.transport.port,
	ca: c.transport.ca,
	servername: c.transport.servername,
	driver:
		c.driver.Client === given.driver.Client &&
		c.driver.Pool === given.driver.Pool &&
		c.driver.DatabaseError === given.driver.DatabaseError,
	open: c.transport.open === given.transport.open,
	password: c.password === given.password
})

/** What the configuration states, its CA as the bundle TLS is handed: one PEM text the bundle of it alone. */
const givenFields = (given: MigrationConnectionConfig): Fields => ({
	role: given.role,
	database: given.database,
	connectTimeoutMs: given.connectTimeoutMs,
	kind: given.transport.kind,
	host: given.transport.host,
	port: given.transport.port,
	ca: typeof given.transport.ca === "string" ? [given.transport.ca] : given.transport.ca,
	servername: given.transport.servername,
	driver: true,
	open: true,
	password: true
})

/** The shapes the agreement must reach in every run, each by some case. */
const connectionFeatures = [
	"an IPv6 host",
	"a role outside ASCII",
	"a password Effect",
	"a CA list",
	"the highest port",
	"the longest timeout"
] as const
type ConnectionFeature = (typeof connectionFeatures)[number]

/** The shapes a drawn connection holds: a code unit past U+007F is a letter outside ASCII, or half a surrogate pair. */
const notes = (d: Drawn): ReadonlyArray<ConnectionFeature> =>
	Arr.flatMap(
		[
			["an IPv6 host", Arr.some(ipv6Hosts, (h) => h === d.host)],
			["a role outside ASCII", Arr.some(Str.split(d.role, ""), (unit) => unit > "\u007f")],
			["a password Effect", d.passwordForm === "effect"],
			["a CA list", d.ca === "list"],
			["the highest port", d.port === 65535],
			["the longest timeout", d.connectTimeoutMs === timerMaxMs.value]
		] satisfies ReadonlyArray<readonly [ConnectionFeature, boolean]>,
		([feature, holds]) => (holds ? [feature] : [])
	)

/** Everything a refusal reports: its message and the whole error, where no value it refuses may appear. */
const reported = (refused: CliError): string =>
	`${refused.message}\n${inspect(refused, { depth: 12 })}`

/** A role fault: the empty role, a value of another kind (the library's wild values that are no text), or none. */
type RoleFault =
	| { readonly kind: "the empty role" }
	| { readonly kind: "a role of another kind"; readonly wild: Wild }
	| { readonly kind: "no role" }

type RoleFaultKind = RoleFault["kind"]

const roleFaultKinds: Arr.NonEmptyReadonlyArray<RoleFaultKind> = [
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

const roleFaultGen: Gen<RoleFault> = oneOf<RoleFault>([
	constant({ kind: "the empty role" }),
	map(wild(otherKinds), (drawnWild) => ({ kind: "a role of another kind", wild: drawnWild })),
	constant({ kind: "no role" })
])

/** The role a fault hands the parse, as JavaScript would. */
const roleOf = (f: Exclude<RoleFault, { readonly kind: "no role" }>): unknown =>
	f.kind === "the empty role" ? "" : passed({ kind: "wild", wild: f.wild })

/** The configuration's connection of `d` with the role fault `f`, as JavaScript would hand it over. */
const faulty = (d: Drawn, f: RoleFault): MigrationConnectionConfig => {
	const typed = { ...typedOf(d) }
	if (f.kind === "no role") {
		Reflect.deleteProperty(typed, "role")
		return typed
	}
	return Object.assign(typed, { role: roleOf(f) })
}

/** The refusal of a role fault: at stage config, naming the configuration's connection.role, the password unquoted. */
const roleRefusal = (r: Result.Result<MigrationConnection, CliError>, password: string): void => {
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
const thrownKinds = [
	"an Error",
	"a tagged error",
	"a value that is no Error",
	"an Error whose message throws"
] as const
type ThrownKind = (typeof thrownKinds)[number]

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

const thrownCase = (kind: ThrownKind, said: string, password: string): ThrownCase => {
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

describe("the configuration's connection, generated", () => {
	it.effect("resolves to exactly the drawn role and connection", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the drawn connection, its role and password as given and the parse's fields"
					},
					suite: "unit/cli/connection-agreement",
					draw: drawn(drawnGen),
					literal: Formatter.format,
					coverage: required<ConnectionFeature>(connectionFeatures, {
						cases: 200,
						sense: notesOnly
					}),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(d, c) =>
					Effect.sync(() => {
						c.noteAll(notes(d))
						const given = typedOf(d)
						const resolved = succeeded(resolveConnection(given), "the drawn connection")
						assert.deepEqual(fields(resolved, given), givenFields(given))
					})
			)
		)
	)

	it.effect(
		"refuses a role that is no nonempty string, or none, at stage config, naming it and never quoting the password",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a role that is no nonempty string is refused at stage config, naming connection.role"
						},
						suite: "unit/cli/connection-role-faults",
						draw: drawn((source) => [source.draw(drawnGen), source.draw(roleFaultGen)] as const),
						literal: Formatter.format,
						coverage: required<RoleFaultKind>(roleFaultKinds, { cases: 100, sense: notesOnly }),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([d, f], c) =>
						Effect.sync(() => {
							c.note(f.kind)
							roleRefusal(resolveConnection(faulty(d, f)), d.password)
						})
				)
			)
	)

	it.effect(
		"refuses a connection that throws at stage config, holding what it threw, stating an Error's message and never the password",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "what a refusal states of a thrown value (cli/errors.ts Said), and the value itself"
						},
						suite: "unit/cli/connection-threw",
						draw: drawn(
							(source) =>
								[
									source.draw(element(thrownKinds)),
									source.draw(textPart),
									source.draw(drawnGen)
								] as const
						),
						literal: Formatter.format,
						coverage: required<ThrownKind>(thrownKinds, { cases: 100, sense: notesOnly }),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([kind, said, d], c) =>
						Effect.sync(() => {
							c.note(kind)
							const thrown = thrownCase(kind, said, d.password)
							const refused = refusedAt(
								calledConnection(() => {
									throw thrown.value
								}),
								"stage",
								"config"
							)
							const reason = refused.reason
							if (reason._tag !== "ConnectionThrew") {
								return assert.fail(`a ConnectionThrew, not ${reason._tag}`)
							}
							assert.ok(
								Redacted.isRedacted(reason.thrown.cause),
								"the refusal holds its cause Redacted"
							)
							assert.ok(
								Redacted.value(reason.thrown.cause) === thrown.value,
								"the refusal holds exactly what was thrown"
							)
							assert.deepEqual(
								reason.thrown.said,
								thrown.said,
								"the refusal states exactly an Error's name and message"
							)
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
		"refuses at stage environment exactly the environments that set PGOPTIONS or PGREPLICATION, naming the first",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the first startup variable an environment sets to a text is refused, none quoted"
						},
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
						caseHang
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
							const refused = refusedAt(result, "stage", "environment")
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
