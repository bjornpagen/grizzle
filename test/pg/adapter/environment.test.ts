/**
 * A login's sessions take nothing from the process environment node-postgres reads: no password from PGPASSWORD or a
 * password file, and no settings from PGOPTIONS.
 *
 * pg reads PGPASSWORD, then the password file PGPASSFILE names (else ~/.pgpass), for any password it is given as a
 * falsy value, and PGOPTIONS for options it is given as none. grizzle gives it a password function always and a login's
 * session its pinned defaults as options (wire/session.ts), so neither source reaches a login's session.
 *
 * One login of the file, made as an installation makes one, its defaults the pinned ones. A case draws the password the
 * pool is configured with, the login's own (a Redacted or an Effect), another, or none (noPassword); PGPASSWORD absent,
 * the login's own or another; a password file absent, holding the login's own or another; and PGOPTIONS absent, empty
 * or at a text whose settings or syntax would change or refuse a session that took it. The file never holds the real
 * ~/.pgpass: PGPASSFILE names a file of the case's, or one that does not exist. Properties:
 * - a lease succeeds exactly when the configured password is the login's own, whatever the environment holds;
 * - an admitted session runs under every pinned default at its stored value, whatever PGOPTIONS holds.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Path,
	Redacted
} from "effect"
import { noPassword, type Password } from "#adapter/wire/session.ts"
import { quoteString, storedSettingValue } from "#compiler/sql/print.ts"
import {
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin
} from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import {
	processEnvironment,
	processValue,
	type VariableValue,
	variableGen
} from "#test/support/process-env.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/** A password the environment offers: the login's own, or another. */
type Offered = "own" | "other"

/** The password the pool is configured with: the login's own, given now or by an Effect; another; or none. */
type Configured =
	| { readonly kind: "own"; readonly lazy: boolean }
	| { readonly kind: "other" }
	| { readonly kind: "none" }

interface EnvironmentCase {
	readonly configured: Configured
	readonly PGPASSWORD: Offered | "absent"
	readonly passwordFile: Offered | "absent"
	readonly PGOPTIONS: VariableValue
}

const offeredGen: Gen<Offered | "absent"> = weighted<Offered | "absent">([
	[1, constant<Offered | "absent">("absent")],
	[2, constant<Offered | "absent">("own")],
	[1, constant<Offered | "absent">("other")]
])

const configuredGen: Gen<Configured> = weighted<Configured>([
	[1, (source): Configured => ({ kind: "own", lazy: source.draw(boolean) })],
	[1, constant<Configured>({ kind: "other" })],
	[2, constant<Configured>({ kind: "none" })]
])

const caseGen: Gen<EnvironmentCase> = (source) => ({
	configured: source.draw(configuredGen),
	PGPASSWORD: source.draw(offeredGen),
	passwordFile: source.draw(offeredGen),
	PGOPTIONS: source.draw(variableGen)
})

type Feature =
	| "none refused beside its own PGPASSWORD"
	| "none refused beside its own password file alone"
	| "another refused beside its own PGPASSWORD"
	| "own admitted beside another PGPASSWORD"
	| "own admitted beside another password file alone"
	| "admitted under PGOPTIONS set"

const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"none refused beside its own PGPASSWORD",
	"none refused beside its own password file alone",
	"another refused beside its own PGPASSWORD",
	"own admitted beside another PGPASSWORD",
	"own admitted beside another password file alone",
	"admitted under PGOPTIONS set"
]

/** What a case reaches, by what it drew. */
const featuresOf = (c: EnvironmentCase): ReadonlyArray<Feature> => [
	...(c.configured.kind === "none" && c.PGPASSWORD === "own"
		? ["none refused beside its own PGPASSWORD" as const]
		: []),
	...(c.configured.kind === "none" && c.PGPASSWORD === "absent" && c.passwordFile === "own"
		? ["none refused beside its own password file alone" as const]
		: []),
	...(c.configured.kind === "other" && c.PGPASSWORD === "own"
		? ["another refused beside its own PGPASSWORD" as const]
		: []),
	...(c.configured.kind === "own" && c.PGPASSWORD === "other"
		? ["own admitted beside another PGPASSWORD" as const]
		: []),
	...(c.configured.kind === "own" && c.PGPASSWORD === "absent" && c.passwordFile === "other"
		? ["own admitted beside another password file alone" as const]
		: []),
	...(c.configured.kind === "own" && c.PGOPTIONS.kind === "text"
		? ["admitted under PGOPTIONS set" as const]
		: [])
]

/** A field of a password file's line, its colons and backslashes escaped. */
const passFileField = (text: string): string =>
	Arr.join(
		Arr.map([...text], (ch) => (ch === ":" || ch === "\\" ? `\\${ch}` : ch)),
		""
	)

/** Every pinned default, as one row of the session's current settings. */
const settingsSql = `SELECT ${Arr.join(
	Arr.map(roleDefaults, (s) => `pg_catalog.current_setting(${quoteString(s.parameter)})`),
	", "
)}`

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"a login's sessions under a hostile process environment",
	(it) => {
		it.effect(
			"authenticate with the configured password alone, and start under the pinned defaults alone",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const fs = yield* FileSystem.FileSystem
						const path = yield* Path.Path
						const schema = yield* s.schema(freshSchema)
						const credentials = yield* substrateLogin(schema, "server", roleDefaults)
						const own = Redacted.value(credentials.password)
						const other = `other-${own}`
						const dir = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-pgpass-" })
						const passFile = path.join(dir, "pgpass")
						const noFile = path.join(dir, "absent")
						const secretOf = (offered: Offered): string => (offered === "own" ? own : other)
						const configuredOf = (c: Configured): Password => {
							switch (c.kind) {
								case "own":
									return c.lazy ? Effect.succeed(credentials.password) : credentials.password
								case "other":
									return Redacted.make(other)
								case "none":
									return noPassword
							}
						}
						return yield* explore(
							{
								suite: "pg/adapter/login-environment",
								draw: drawn(caseGen),
								literal: Formatter.format,
								coverage: required<Feature>(situations, { cases: 80, sense: notesOnly }),
								kept: [],
								runs: 40,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 8,
								caseHang: Duration.minutes(1)
							},
							(c, k) =>
								Effect.scoped(
									Effect.gen(function* () {
										if (c.passwordFile !== "absent") {
											yield* fs.writeFileString(
												passFile,
												`*:*:*:*:${passFileField(secretOf(c.passwordFile))}\n`,
												{ mode: 0o600 }
											)
										}
										yield* processEnvironment({
											PGPASSWORD:
												c.PGPASSWORD === "absent"
													? Option.none()
													: Option.some(secretOf(c.PGPASSWORD)),
											PGPASSFILE: Option.some(c.passwordFile === "absent" ? noFile : passFile),
											PGOPTIONS: processValue(c.PGOPTIONS)
										})
										const pool = yield* poolFor(credentials, {
											...defaultPool,
											password: { kind: "given", password: configuredOf(c.configured) }
										})
										const exit = yield* Effect.exit(
											Effect.scoped(
												Effect.flatMap(pool.lease, (session) => rowsOn(session, settingsSql, []))
											)
										)
										if (c.configured.kind !== "own") {
											assert.ok(
												Exit.isFailure(exit),
												"a pool not configured with the login's own password authenticates"
											)
										} else {
											assert.ok(Exit.isSuccess(exit), "the login's own password is refused")
											assert.deepEqual(exit.value, [Arr.map(roleDefaults, storedSettingValue)])
										}
										k.noteAll(featuresOf(c))
									})
								)
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
