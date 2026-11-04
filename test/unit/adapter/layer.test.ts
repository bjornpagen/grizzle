import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Exit,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	String as Str
} from "effect"
import { type StartupVariable, startupVariableNames } from "#adapter/connection/environment.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { ConnectionEnvironmentRefused, DbConfigRefused } from "#adapter/errors/failures.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { DbConfigShape } from "#adapter/types/layer.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, relation, role, schema } from "#compiler/public/schema.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { atDeclaredName, installationOf } from "#test/support/kernel/naming.ts"
import { fromEmpty, generate } from "#test/support/migrate/kit.ts"
import {
	processEnvironment,
	processValue,
	valueMark,
	type VariableValue,
	variableGen
} from "#test/support/process-env.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

/**
 * DbLayer.make parses its DbConfig once, where it is given (packages/grizzle/src/adapter/pool/registry.ts, connection/config.ts), and a
 * config no connection can use fails the layer before any connection.
 *
 * Over drawn configs (tricky hosts, databases and passwords; a Redacted or an Effect password; a CA as one PEM text or a
 * list; a servername or none; a pool hook and a verify or none) for a login whose roles read no context, a valid one
 * builds its layer, which opens no session until a Db is opened on it. The same config with one fault injected, each a
 * refusal the typed DbConfig already rules out but a JavaScript caller can pass (a setting of another type, missing,
 * empty or null, a port outside 1 to 65535 or no integer, an unknown key at the top or in tls, a TLS block no
 * verify-full connection can use, a login no login(...) built, a pool hook or a verify that is no function, no verify
 * for a login one of whose roles reads a context), fails the layer with OpenError{stage: "config"} whose
 * DbConfigRefused names the faulty setting and never quotes the password. The faults mirror the typed
 * migration connection's (test/unit/cli/connection.test.ts): one parser reads both blocks, under their own login key.
 *
 * The same valid configs under a drawn process environment, the one pg reads (connection/environment.ts): each startup
 * variable, `PGOPTIONS` and `PGREPLICATION`, absent, empty or at a text, beside variables pg reads that grizzle's client
 * configuration sets, at any text. The layer is refused at stage config exactly when `PGREPLICATION` holds a text, the
 * one startup variable a login's sessions cannot override, with a ConnectionEnvironmentRefused naming it and quoting no
 * value, and is built otherwise: a login's sessions set their own options, so `PGOPTIONS` reaches none of them.
 *
 * Characters a text setting may hold that a parser could read specially, and characters outside ASCII.
 */
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
	"é",
	"語",
	"😀"
]
const textGen: Gen<string> = string(
	weighted([
		[3, element(Str.split("abcxyz019_-.", ""))],
		[1, element(tricky)]
	]),
	{ min: 1, max: 6 }
)

const pem = (body: string): string =>
	`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`

/**
 * A login whose one role reads no context, which a valid config names; and one whose role reads a context, which needs
 * a verify.
 */
const Item = relation("Item", { id: uuid, owner: uuid }, ["id"])
const Shelf = schema("Shelf", { Item }, [])
const Plain = login(Shelf, "plain", [role(Shelf, "shelver", { Item })])
const Session = context("Session", { sub: uuid })
const owned = query(Shelf).rule((r) => {
	const { id, owner } = v(Item, "item")
	return r.match(Item, { id, owner }).match(Session, { sub: owner }).find({ id })
})
const Claiming = login(Shelf, "claiming", [role(Shelf, "owner", { Owned: owned })])

/**
 * Shelf's snapshot.json, as an import of it yields: what every config is given, of the logins' base and recording no
 * workload, as neither login owns one.
 */
const shelfSnapshot = snapshotJson(
	succeeded(
		generate({
			installation: installationOf(Shelf, atDeclaredName),
			name: "shelf",
			timestamp: "20261024000000",
			previous: fromEmpty,
			workload: noWorkload
		}),
		"Shelf's first migration"
	).snapshotText
)

/** A valid config: every rule parseConnection states holds, the password a Redacted or an Effect yielding one. */
interface Drawn {
	readonly config: DbConfigShape<typeof Plain>
	readonly password: string
}

const drawnGen: Gen<Drawn> = (source) => {
	const host = source.draw(textGen)
	const port = source.draw(int(1, 65535))
	const database = source.draw(textGen)
	/** Marked, so a refusal quoting it cannot be mistaken for one that spells a setting's name alike. */
	const password = `pw-${source.draw(textGen)}`
	const lazy = source.draw(boolean)
	const ca = source.draw(
		oneOf<string | ReadonlyArray<string>>([
			map(textGen, pem),
			array(map(textGen, pem), { min: 1, max: 2 })
		])
	)
	const servername = Option.getOrUndefined(source.draw(option(textGen)))
	/**
	 * A platform's pool hook, or none: building the layer never calls it, since no pool exists before a Db.open.
	 */
	const attachPool = source.draw(boolean)
	/**
	 * A verify, or none: the login's roles read no context, so it needs none, and building the layer never calls it.
	 */
	const verify = source.draw(boolean)
	return {
		password,
		config: {
			host,
			port,
			database,
			login: Plain,
			snapshot: shelfSnapshot,
			password: lazy ? Effect.succeed(Redacted.make(password)) : Redacted.make(password),
			tls: servername === undefined ? { ca } : { ca, servername },
			...(attachPool ? { attachPool: () => undefined } : {}),
			...(verify ? { verify: () => Effect.succeed({}) } : {})
		}
	}
}

/** A setting of DbConfig a fault breaks. */
type Setting =
	| "host"
	| "database"
	| "login"
	| "verify"
	| "port"
	| "password"
	| "tls"
	| "tls.ca"
	| "tls.servername"
	| "attachPool"

/** What a run reaches: its valid config built, and its fault refused at the setting it breaks, or as an unknown key. */
type LayerFeature = "valid built" | `refused DbConfig.${Setting}` | "refused an unknown setting"

/** What a refusal must name: a setting of DbConfig, or an unknown key, quoted. */
type Named =
	| { readonly kind: "setting"; readonly setting: Setting }
	| { readonly kind: "unknown"; readonly key: string }

/** One fault: the settings it overrides at the top, or in tls, and what the refusal must name. */
interface Fault {
	readonly override: Readonly<Record<string, unknown>>
	readonly tls: Readonly<Record<string, unknown>>
	readonly names: Named
}

const fault = (
	names: Named,
	override: Readonly<Record<string, unknown>>,
	tls: Readonly<Record<string, unknown>>
): Fault => ({ override, tls, names })

const setting = (s: Setting): Named => ({ kind: "setting", setting: s })
const unknownKey = (key: string): Named => ({ kind: "unknown", key })

/** The text a refusal names `names` by. */
const nameText = (names: Named): string =>
	names.kind === "setting" ? `DbConfig.${names.setting}` : Formatter.format(names.key)

/**
 * A login one of whose roles reads a context, without a verify: no Db of it could turn a token into claims.
 */
const faultGen: Gen<Fault> = oneOf<Fault>([
	map(element(["role", "user", "ssl", "sslmode", "options"]), (key) =>
		fault(unknownKey(key), { [key]: "x" }, {})
	),
	(source) => {
		const key = source.draw(element(["host", "database"] as const))
		const value = source.draw(element<unknown>(["", 1, undefined, null]))
		return fault(setting(key), { [key]: value }, {})
	},
	map(element<unknown>(["", 1, undefined, null, {}, Shelf, "plain"]), (value) =>
		fault(setting("login"), { login: value }, {})
	),
	map(element<unknown>(["verify", 1, null, {}]), (value) =>
		fault(setting("verify"), { verify: value }, {})
	),
	constant(fault(setting("verify"), { login: Claiming, verify: undefined }, {})),
	map(
		element<unknown>([
			0,
			-1,
			65536,
			54.32,
			"5432",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			undefined
		]),
		(port) => fault(setting("port"), { port }, {})
	),
	map(element<unknown>(["plain text", undefined, 42, { value: "x" }, null]), (password) =>
		fault(setting("password"), { password }, {})
	),
	map(element<unknown>([undefined, "verify-full", null, []]), (tls) =>
		fault(setting("tls"), { tls }, {})
	),
	map(element(["mode", "sslmode", "rejectUnauthorized"]), (key) =>
		fault(unknownKey(key), {}, { [key]: "x" })
	),
	map(element<unknown>(["", [], [""], 42, undefined]), (ca) =>
		fault(setting("tls.ca"), {}, { ca })
	),
	map(element<unknown>(["", 7, null]), (servername) =>
		fault(setting("tls.servername"), {}, { servername })
	),
	map(element<unknown>(["attachDatabasePool", 1, null, {}]), (attachPool) =>
		fault(setting("attachPool"), { attachPool }, {})
	)
])

/** A layer, whatever it provides, built in a scope of its own and closed: its exit. */
const built = (
	layer: Layer.Layer<never, OpenError>
): Effect.Effect<Exit.Exit<unknown, OpenError>> => Effect.exit(Effect.scoped(Layer.build(layer)))

/**
 * Variables pg reads into a session that grizzle's client configuration sets itself, or that pg's client never uses:
 * no value of theirs reaches a session, so none refuses a layer.
 */
const statedVariables: Arr.NonEmptyReadonlyArray<string> = [
	"PGAPPNAME",
	"PGCLIENT_ENCODING",
	"PGSSLNEGOTIATION",
	"PGSSLMODE",
	"PGHOST",
	"PGPORT",
	"PGUSER",
	"PGDATABASE",
	"PGPASSWORD",
	"PGPASSFILE",
	"PGCONNECT_TIMEOUT",
	"PGBINARY"
]

/** A drawn environment: each startup variable's value, and variables grizzle sets itself, each at a text. */
interface Environment {
	readonly variables: { readonly [V in StartupVariable]: VariableValue }
	readonly stated: ReadonlyArray<readonly [string, string]>
}

const environmentGen: Gen<Environment> = (source) => ({
	variables: { PGOPTIONS: source.draw(variableGen), PGREPLICATION: source.draw(variableGen) },
	stated: source.draw(
		array(
			(inner) =>
				[
					inner.draw(element(statedVariables)),
					inner.draw(element(["direct", "latin1", "1", "x"]))
				] as const,
			{ min: 0, max: 3 }
		)
	)
})

/** A drawn environment as the process holds it, every variable it does not set unset. */
const processValues = (e: Environment): Readonly<Record<string, Option.Option<string>>> => ({
	...Rec.fromEntries(Arr.map(statedVariables, (name) => [name, Option.none<string>()] as const)),
	...Rec.fromEntries(Arr.map(e.stated, ([name, text]) => [name, Option.some(text)] as const)),
	...Rec.fromEntries(
		Arr.map(startupVariableNames, (name) => [name, processValue(e.variables[name])] as const)
	)
})

/** What a run of the environment property reaches. */
type EnvironmentFeature =
	| "refused PGREPLICATION set"
	| "refused PGREPLICATION beside PGOPTIONS set"
	| "built with PGOPTIONS set"
	| "built with a variable empty"
	| "built beside a variable grizzle sets"

describe("DbLayer.make", () => {
	it.live(
		"builds every valid config, and refuses every fault injected into one at stage config, naming it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/layer-config",
						draw: drawn((source) => [source.draw(drawnGen), source.draw(faultGen)] as const),
						literal: Formatter.format,
						coverage: required<LayerFeature>(
							[
								"valid built",
								"refused DbConfig.host",
								"refused DbConfig.login",
								"refused DbConfig.verify",
								"refused DbConfig.port",
								"refused DbConfig.password",
								"refused DbConfig.tls",
								"refused DbConfig.tls.ca",
								"refused DbConfig.tls.servername",
								"refused DbConfig.attachPool",
								"refused an unknown setting"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([d, f], k) =>
						Effect.gen(function* () {
							const names = nameText(f.names)
							const valid = yield* built(DbLayer.make(d.config))
							assert.ok(
								Exit.isSuccess(valid),
								`a valid config is refused: ${Exit.isFailure(valid) ? Cause.pretty(valid.cause) : ""}`
							)
							k.note("valid built")
							/** The config with the fault injected: a fault that replaces tls whole leaves no tls to extend. */
							const injected: DbConfigShape<typeof Plain> = Rec.has(f.override, "tls")
								? Object.assign({ ...d.config }, f.override)
								: Object.assign({ ...d.config }, f.override, {
										tls: Object.assign({ ...d.config.tls }, f.tls)
									})
							const exit = yield* built(DbLayer.make(injected))
							assert.ok(Exit.isFailure(exit), `the fault at ${names} builds a layer`)
							const error = Cause.squash(exit.cause)
							assert.ok(
								error instanceof OpenError,
								`the fault at ${names} fails with ${String(error)}`
							)
							assert.equal(error.stage, "config")
							assert.ok(
								error.reason instanceof DbConfigRefused,
								`the fault at ${names} has no DbConfigRefused reason`
							)
							const detail = error.reason.detail
							assert.ok(Str.includes(names)(detail), `${detail} does not name ${names}`)
							assert.ok(!Str.includes(d.password)(detail), `${detail} quotes the password`)
							assert.ok(
								!Str.includes(d.password)(error.message),
								`${error.message} quotes the password`
							)
							k.note(
								f.names.kind === "setting"
									? `refused DbConfig.${f.names.setting}`
									: "refused an unknown setting"
							)
						})
				)
			)
	)
	it.live(
		"refuses at stage config exactly the process environments that set PGREPLICATION, and builds under PGOPTIONS",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/layer-environment",
						draw: drawn((source) => [source.draw(drawnGen), source.draw(environmentGen)] as const),
						literal: Formatter.format,
						coverage: required<EnvironmentFeature>(
							[
								"refused PGREPLICATION set",
								"refused PGREPLICATION beside PGOPTIONS set",
								"built with PGOPTIONS set",
								"built with a variable empty",
								"built beside a variable grizzle sets"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([d, e], k) =>
						Effect.gen(function* () {
							const exit = yield* Effect.scoped(
								Effect.andThen(processEnvironment(processValues(e)), built(DbLayer.make(d.config)))
							)
							const options = e.variables.PGOPTIONS
							if (e.variables.PGREPLICATION.kind !== "text") {
								assert.ok(
									Exit.isSuccess(exit),
									`an environment that sets no PGREPLICATION is refused: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
								)
								if (options.kind === "text") {
									k.note("built with PGOPTIONS set")
								}
								if (Arr.some(startupVariableNames, (v) => e.variables[v].kind === "empty")) {
									k.note("built with a variable empty")
								}
								if (Arr.isReadonlyArrayNonEmpty(e.stated)) {
									k.note("built beside a variable grizzle sets")
								}
								return
							}
							assert.ok(Exit.isFailure(exit), "PGREPLICATION builds a layer")
							const error = Cause.squash(exit.cause)
							assert.ok(error instanceof OpenError, `the environment fails with ${String(error)}`)
							assert.equal(error.stage, "config")
							assert.ok(
								error.reason instanceof ConnectionEnvironmentRefused,
								`the environment's refusal is ${error.reason._tag}`
							)
							assert.equal(error.reason.variable, "PGREPLICATION")
							assert.ok(!Str.includes(valueMark)(error.message), `${error.message} quotes a value`)
							k.note("refused PGREPLICATION set")
							if (options.kind === "text") {
								k.note("refused PGREPLICATION beside PGOPTIONS set")
							}
						})
				)
			)
	)
})
