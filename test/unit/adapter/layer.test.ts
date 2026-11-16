import { inspect } from "node:util"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect, Exit, Option, String as Str } from "effect"
import { startupVariableNames } from "#adapter/connection/environment.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	ClaimRefused,
	ConnectionEnvironmentRefused,
	DbConfigRefused,
	TokenError,
	TokenMalformed
} from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { DbConfigShape } from "#adapter/types/layer.ts"
import { assert, lacksText } from "#test/support/assert.ts"
import { memoryEndpoint, memoryTransport } from "#test/support/memory-tls.ts"
import { processEnvironment, valueMark } from "#test/support/process-env.ts"
import { withLayer } from "#test/support/with-layer.ts"
import {
	built,
	Claiming,
	ClaimingServed,
	closingMaterial,
	drawnGen,
	type EnvironmentFeature,
	environmentGen,
	faultGen,
	type LayerFeature,
	nameText,
	payloadValue,
	Plain,
	processValues,
	ruleOf,
	settingOf,
	thrownValue,
	tokenCaseGen,
	type TokenFeature,
	tokenVerdict
} from "#test/unit/adapter/layer.fixtures.ts"

/** DbLayer.make builds every valid config, and refuses every fault injected into one at stage config, naming it. */
export const dbLayerMakeBuildsEveryValidConfigAndRefusesEveryFaultInjectedIntoOneAtStageConfigNamingIt =
	property.explore((source) => [source.draw(drawnGen), source.draw(faultGen)] as const, {
		needs: {},
		situations: [
			"valid built",
			"refused DbConfig.driver",
			"refused DbConfig.transport",
			"refused DbConfig.transport.kind",
			"refused DbConfig.transport.host",
			"refused DbConfig.transport.port",
			"refused DbConfig.transport.open",
			"refused DbConfig.transport.ca",
			"refused DbConfig.transport.servername",
			"refused DbConfig.database",
			"refused DbConfig.password",
			"refused DbConfig.connectTimeoutMs",
			"refused DbConfig.pool",
			"refused DbConfig.pool.max",
			"refused DbConfig.pool.min",
			"refused DbConfig.pool.idleTimeoutMs",
			"refused DbConfig.login",
			"refused DbConfig.verify",
			"refused DbConfig.attachPool",
			"refused an unknown setting",
			"refused a host that is a path"
		] satisfies ReadonlyArray<Reached<LayerFeature>>,
		check:
			(_, k: Case<LayerFeature>) =>
			([d, f]) =>
				Effect.gen(function* () {
					const names = nameText(f.names)
					const valid = yield* built(DbLayer.make(d.config))
					assert.ok(
						Exit.isSuccess(valid),
						`a valid config is refused: ${Exit.isFailure(valid) ? Cause.pretty(valid.cause) : ""}`
					)
					k.note("valid built")
					/** The config with the fault injected at its place, the rest of the config as drawn. */
					const injected: DbConfigShape<typeof Plain> =
						f.place === "top"
							? Object.assign({ ...d.config }, f.override)
							: f.place === "transport"
								? Object.assign(
										{ ...d.config },
										{
											transport: Object.assign({ ...d.config.transport }, f.override)
										}
									)
								: Object.assign(
										{ ...d.config },
										{
											pool: Object.assign({ ...d.config.pool }, f.override)
										}
									)
					const exit = yield* built(DbLayer.make(injected))
					assert.ok(Exit.isFailure(exit), `the fault at ${names} builds a layer`)
					const error = Cause.squash(exit.cause)
					assert.ok(error instanceof OpenError, `the fault at ${names} fails with ${String(error)}`)
					assert.equal(error.stage, "config")
					assert.ok(
						error.reason instanceof DbConfigRefused,
						`the fault at ${names} has no DbConfigRefused reason`
					)
					const refused = error.reason
					assert.deepEqual<ReadonlyArray<string>>(
						refused.setting,
						settingOf(f),
						`the fault at ${names} names its setting`
					)
					Option.match(ruleOf(f), {
						onNone: () => undefined,
						onSome: (kind) => assert.equal(refused.rule.kind, kind, `the fault at ${names}`)
					})
					lacksText(
						`${error.message}\n${inspect(refused, { depth: 12 })}`,
						d.password,
						`the refusal of the fault at ${names} quotes the password`
					)
					k.note(f.reaches)
				}),
		oracle: {
			kind: "specification",
			name: "DbConfig's documented settings: a valid config builds, each injected fault is DbConfigRefused naming its setting"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/connection/config.ts",
				original:
					"export const timerDelay = (v: number): boolean => integerIn(v, timerMinMs.value, timerMaxMs.value)",
				replacement:
					"export const timerDelay = (v: number): boolean => integerIn(v, 0, timerMaxMs.value)",
				why: "A timer's delay of 0 is admitted."
			},
			{
				file: "packages/grizzle/src/adapter/connection/config.ts",
				original:
					'\tconst transport = parseTransport(transportRead.value, [...where, "transport"])',
				replacement: "\tconst transport = parseTransport(transportRead.value, where)",
				why: "A transport setting's refusal names it as the block's own, its path missing \"transport\"."
			}
		]
	})

/** DbLayer.make refuses at stage config exactly the process environments that set PGREPLICATION, and builds under PGOPTIONS. */
export const dbLayerMakeRefusesAtStageConfigExactlyTheProcessEnvironmentsThatSetPGREPLICATIONAndBuildsUnderPGOPTIONS =
	property.explore((source) => [source.draw(drawnGen), source.draw(environmentGen)] as const, {
		needs: {},
		situations: [
			"refused PGREPLICATION set",
			"refused PGREPLICATION beside PGOPTIONS set",
			"built with PGOPTIONS set",
			"built with a variable empty",
			"built beside a variable grizzle sets"
		] satisfies ReadonlyArray<Reached<EnvironmentFeature>>,
		check:
			(_, k: Case<EnvironmentFeature>) =>
			([d, e]) =>
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
				}),
		oracle: {
			kind: "specification",
			name: "a login's layer is refused exactly when PGREPLICATION holds a text"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/connection/environment.ts",
				original: '\tlogin: ["PGREPLICATION"],',
				replacement: '\tlogin: ["PGOPTIONS", "PGREPLICATION"],',
				why: "A login's layer is refused under PGOPTIONS too."
			}
		]
	})

/** DbLayer.make judges a token at stage token before any connection: no token68 a TokenMalformed, verify's refusal or throw a TokenError, a payload that does not decode a ClaimRefused. */
export const dbLayerMakeJudgesATokenAtStageTokenBeforeAnyConnectionNoToken68ATokenMalformedVerifysRefusalOrThrowATokenErrorAPayloadThatDoesNotDecodeAClaimRefused =
	property.explore((source) => [source.draw(drawnGen), source.draw(tokenCaseGen)] as const, {
		needs: {},
		situations: [
			"a token that is no token68",
			"verify refuses",
			"verify throws an Error",
			"verify throws a TypeError",
			"verify throws a RangeError",
			"verify throws an Error with a cause",
			"refused notAnObject",
			"refused missing",
			"refused refused",
			"claims decoded"
		] satisfies ReadonlyArray<Reached<TokenFeature>>,
		check:
			(_, k: Case<TokenFeature>) =>
			([d, c]) =>
				Effect.gen(function* () {
					let verified = 0
					let opened = 0
					const thrown: Array<Error> = []
					const refusal = new TokenError({ cause: "the verifier refused the token" })
					const verify = (): Effect.Effect<unknown, TokenError> => {
						verified++
						const behaviour = c.verify
						switch (behaviour.kind) {
							case "refuses":
								return Effect.fail(refusal)
							case "throws": {
								const error = thrownValue(behaviour.thrown)
								thrown.push(error)
								throw error
							}
							case "returns":
								return Effect.succeed(payloadValue(behaviour.payload))
						}
					}
					const open = memoryEndpoint(closingMaterial, (secure) => {
						secure.destroy()
					})
					const config: DbConfigShape<typeof Claiming> = {
						...d.config,
						login: ClaimingServed,
						verify,
						transport: memoryTransport(closingMaterial, () => {
							opened++
							return open()
						})
					}
					const exit = yield* Effect.exit(
						Db.open(ClaimingServed.roles.owner, { token: c.token }).pipe(
							withLayer(DbLayer.make(config)),
							Effect.scoped
						)
					)
					const verdict = tokenVerdict(c)
					assert.equal(
						verified,
						verdict.kind === "TokenMalformed" ? 0 : 1,
						"verify runs once on a token68, and never on any other token"
					)
					assert.equal(opened, 0, "Db.open opens no socket, whatever the token")
					if (verdict.kind === "opened") {
						assert.ok(
							Exit.isSuccess(exit),
							`decoded claims open a Db, though the endpoint ends every connection: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
						)
						k.note("claims decoded")
						return
					}
					assert.ok(Exit.isFailure(exit), "a refused token opens no Db")
					const error = Cause.squash(exit.cause)
					assert.ok(error instanceof OpenError, String(error))
					switch (verdict.kind) {
						case "TokenMalformed":
							assert.equal(error.stage, "token")
							assert.ok(error.reason instanceof TokenMalformed, String(error.reason))
							k.note("a token that is no token68")
							break
						case "TokenError":
							assert.equal(error.stage, "token")
							assert.ok(error.reason instanceof TokenError, String(error.reason))
							if (c.verify.kind === "throws") {
								assert.deepEqual([error.reason.cause], thrown, "the throw is its cause")
								k.note(`verify throws ${c.verify.thrown}`)
							} else {
								assert.ok(error.reason === refusal, "verify's own TokenError")
								k.note("verify refuses")
							}
							break
						case "ClaimRefused":
							assert.equal(error.stage, "token")
							assert.deepEqual(
								error.reason,
								new ClaimRefused({ context: "Session", fault: verdict.fault })
							)
							k.note(`refused ${verdict.fault.kind}`)
							break
					}
				}),
		oracle: {
			kind: "specification",
			name: "the README's order of Db.open's stages and their reasons, over the drawn verify and payload"
		},
		kept: [],
		kills: []
	})
