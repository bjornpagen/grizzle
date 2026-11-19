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
 *
 * Features: a missing or wrong configured password refused beside the login's own in PGPASSWORD or the password file,
 * the login's own admitted beside another, and admitted under a PGOPTIONS that is set.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, FileSystem, Option, Path, Redacted } from "effect"
import type { Password } from "#adapter/wire/session.ts"
import { storedSettingValue } from "#compiler/sql/print.ts"
import {
	caseGen,
	type Configured,
	type Feature,
	featuresOf,
	type Offered,
	passFileField,
	settingsSql,
	situations
} from "#test/pg/adapter/environment.fixtures.ts"
import {
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin
} from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import { noPassword } from "#test/support/pg.ts"
import { processEnvironment, processValue } from "#test/support/process-env.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A login's sessions under a hostile process environment authenticate with the configured password alone, and start under the pinned defaults alone.
 *
 * Its pre-conversion budget: runs 40, coverage cases 80 (test/pg/adapter/environment.test.ts at d8eed1786).
 */
export const aLoginsSessionsUnderAHostileProcessEnvironmentAuthenticateWithTheConfiguredPasswordAloneAndStartUnderThePinnedDefaultsAlone =
	property.explore(caseGen, {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, k: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
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
						return yield* Effect.scoped(
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
										c.PGPASSWORD === "absent" ? Option.none() : Option.some(secretOf(c.PGPASSWORD)),
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
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a session authenticates by the configured password alone and starts under the pinned defaults"
		},
		budget: { runs: 40, steered: 80 },
		kept: [],
		kills: []
	})
