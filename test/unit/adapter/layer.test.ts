import { inspect } from "node:util"
import { assert, lacksText } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect, Exit, Option, String as Str } from "effect"
import { startupVariableNames } from "#adapter/connection/environment.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	ClaimRefused,
	ConnectionEnvironmentRefused,
	DbConfigRefused,
	TokenMalformed,
	TokenRefused,
	VerifierUnavailable
} from "#adapter/errors/failures.ts"
import { openCallError } from "#adapter/live/call-error.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { DbConfigShape } from "#adapter/types/layer.ts"
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

/**
 * DbLayer.make builds every valid config, and refuses every fault injected into one at stage config, naming it.
 *
 * Budget: its suite's count before the conversion (unit/adapter/layer-config: 400 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
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
			"refused DbConfig.pool",
			"refused DbConfig.pool.max",
			"refused DbConfig.login",
			"refused DbConfig.verify",
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
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/connection/config.ts",
				original:
					'\tconst transport = parseTransport(transportRead.value, [...where, "transport"])',
				replacement: "\tconst transport = parseTransport(transportRead.value, where)",
				why: "A transport setting's refusal names it as the block's own, its path missing \"transport\"."
			}
		]
	})

/**
 * DbLayer.make refuses at stage config exactly the process environments that set PGREPLICATION, and builds under
 * PGOPTIONS.
 *
 * Budget: its suite's count before the conversion (unit/adapter/layer-environment: 200 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
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
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/connection/environment.ts",
				original: '\t"PGREPLICATION"\n',
				replacement: '\t"PGOPTIONS",\n\t"PGREPLICATION"\n',
				why: "A login's layer is refused under PGOPTIONS too."
			}
		]
	})

/**
 * DbLayer.make judges a token at stage token before any connection: no token68 a TokenMalformed, verify's refusal or
 * throw a TokenRefused, a payload that does not decode a ClaimRefused.
 *
 * Budget: its suite's count before the conversion (unit/adapter/layer-token: 150 independent cases and 96 steered,
 * Vitest at grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (verify throws a
 * RangeError, verify throws an Error with a cause; toolchain-test run of 2026-11-16 08:21Z), so its steered phase
 * keeps the runner's cap of 200, which it stops short of once every situation is reached.
 */
export const dbLayerMakeJudgesATokenAtStageTokenBeforeAnyConnectionNoToken68ATokenMalformedVerifysRefusalOrThrowATokenRefusedAPayloadThatDoesNotDecodeAClaimRefused =
	property.explore((source) => [source.draw(drawnGen), source.draw(tokenCaseGen)] as const, {
		needs: {},
		situations: [
			"a token that is no token68",
			"verify refuses",
			"verify's verifier unavailable",
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
					const refusal = new TokenRefused({ cause: "the verifier refused the token" })
					const outage = new VerifierUnavailable({ cause: { status: 503 } })
					const verify = (): Effect.Effect<unknown, TokenRefused | VerifierUnavailable> => {
						verified++
						const behaviour = c.verify
						switch (behaviour.kind) {
							case "refuses":
								return Effect.fail(refusal)
							case "unavailable":
								return Effect.fail(outage)
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
					const served = openCallError(error)
					if (verdict.kind === "VerifierUnavailable") {
						assert.equal(error.stage, "token")
						assert.ok(error.reason === outage, "verify's own VerifierUnavailable")
						assert.equal(error.retry, "safe", "an unavailable verifier's open may be retried")
						assert.equal(
							served._tag,
							"unavailable",
							"over HTTP, an unavailable verifier is no refused token"
						)
						assert.equal(served.retry, "safe")
						k.note("verify's verifier unavailable")
						return
					}
					assert.equal(error.retry, "never", "every other open meets the same answer again")
					assert.notEqual(
						served.retry,
						"safe",
						"over HTTP, no other refusal of the open is retried"
					)
					switch (verdict.kind) {
						case "TokenMalformed":
							assert.equal(error.stage, "token")
							assert.ok(error.reason instanceof TokenMalformed, String(error.reason))
							k.note("a token that is no token68")
							break
						case "TokenRefused":
							assert.equal(error.stage, "token")
							assert.ok(error.reason instanceof TokenRefused, String(error.reason))
							if (c.verify.kind === "throws") {
								assert.deepEqual([error.reason.cause], thrown, "the throw is its cause")
								k.note(`verify throws ${c.verify.thrown}`)
							} else {
								assert.ok(error.reason === refusal, "verify's own TokenRefused")
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
		budget: { runs: 150, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/live/call-error.ts",
				original: '\tVerifierUnavailable: "unavailable",',
				replacement: '\tVerifierUnavailable: "tokenRefused",',
				why: "An unavailable verifier reads over HTTP as a refused token, never retried: a call met while the verifier is down fails for good."
			},
			{
				file: "packages/grizzle/src/adapter/errors/execution.ts",
				original: '\treason._tag === "VerifierUnavailable" ? "safe" : "never"',
				replacement: '\t"never"',
				why: "Db.open's OpenError of an unavailable verifier says never to retry, as a refused token's does."
			},
			{
				file: "packages/grizzle/src/adapter/connection/environment.ts",
				original: '\t\treturn value !== undefined && value !== ""',
				replacement: '\t\treturn value !== ""',
				why: 'Operator mutant (conjunct) at packages/grizzle/src/adapter/connection/environment.ts:44 in startupVariableSet: `value !== undefined && value !== ""` becomes `value !== ""`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})
