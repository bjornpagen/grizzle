/**
 * Where `grizzle migrate` and `grizzle drift` connect, generated: the configuration's connection, and nothing else.
 *
 * - Agreement: a connection drawn with tricky parts (reserved and non-ASCII characters in the role, password, database,
 *   host, servername and socket directory, the host never a path, IPv6 hosts, ports across their range, a CA as one
 *   text or a list, a password Redacted or an Effect, or a Unix socket's directory, an absolute path, and no password)
 *   resolves to exactly the drawn role and connection, its CA the bundle TLS is handed: the parse of the connection
 *   (adapter/connection/config.ts, whose faults test/unit/adapter/layer.test.ts injects through DbLayer.make) plus the
 *   role and the password kept as given, and the driver as the three classes it reads off the given module once (its
 *   Client, Pool and DatabaseError), never the module itself, so no getter of another member runs.
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
 * Features: the connection's tricky shapes, each role fault, each thrown value, and each environment's verdict.
 */
import { assert, lacksText } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec, Redacted } from "effect"
import { startupVariableNames } from "#adapter/connection/environment.ts"
import { ConnectionEnvironmentRefused } from "#adapter/errors/failures.ts"
import { calledConnection, ownerEnvironment, resolveConnection } from "#cli/connection.ts"
import { refusedAt, succeeded } from "#test/support/assert.ts"
import {
	processEnvironment,
	processValue,
	valueMark,
	variableGen
} from "#test/support/process-env.ts"
import {
	type ConnectionFeature,
	connectionFeatures,
	drawnGen,
	faulty,
	fields,
	givenFields,
	notes,
	type OwnerEnvironment,
	type OwnerEnvironmentFeature,
	reported,
	roleFaultGen,
	type RoleFaultKind,
	roleFaultKinds,
	roleRefusal,
	textPart,
	thrownCase,
	type ThrownKind,
	thrownKinds,
	typedOf
} from "#test/unit/cli/connection.fixtures.ts"

/**
 * The configuration's connection, generated resolves to exactly the drawn role and connection.
 *
 * Budget: its suite's count before the conversion (unit/cli/connection-agreement: 200 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theConfigurationsConnectionGeneratedResolvesToExactlyTheDrawnRoleAndConnection =
	property.explore(drawnGen, {
		needs: {},
		situations: connectionFeatures satisfies ReadonlyArray<Reached<ConnectionFeature>>,
		check: (_, c: Case<ConnectionFeature>) => (d) =>
			Effect.sync(() => {
				c.noteAll(notes(d))
				const given = typedOf(d)
				const resolved = succeeded(resolveConnection(given), "the drawn connection")
				assert.deepEqual(fields(resolved, given), givenFields(given))
			}),
		oracle: {
			kind: "specification",
			name: "the drawn connection, its role and password as given and the parse's fields"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/connection/config.ts",
				original: "\t\t\tauthority,\n\t\t\tservername\n\t\t})",
				replacement: "\t\t\tauthority,\n\t\t\tservername: host\n\t\t})",
				why: "The parsed transport names its host as the servername TLS verifies, where the configuration names its own: the drawn connection's servername is not resolved; the agreement fails."
			}
		]
	})

/**
 * The configuration's connection, generated refuses a role that is no nonempty string, or none, at stage config,
 * naming it and never quoting the password.
 *
 * Budget: its suite's count before the conversion (unit/cli/connection-role-faults: 100 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const theConfigurationsConnectionGeneratedRefusesARoleThatIsNoNonemptyStringOrNoneAtStageConfigNamingItAndNeverQuotingThePassword =
	property.explore((source) => [source.draw(drawnGen), source.draw(roleFaultGen)] as const, {
		needs: {},
		situations: roleFaultKinds satisfies ReadonlyArray<Reached<RoleFaultKind>>,
		check:
			(_, c: Case<RoleFaultKind>) =>
			([d, f]) =>
				Effect.sync(() => {
					c.note(f.kind)
					roleRefusal(resolveConnection(faulty(d, f)), d.password)
				}),
		oracle: {
			kind: "specification",
			name: "a role that is no nonempty string is refused at stage config, naming connection.role"
		},
		budget: { runs: 100, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/connection/config.ts",
				original: '\t\treturn typeof role === "string" && role !== ""',
				replacement: '\t\treturn typeof role === "string"',
				why: "An empty role is admitted."
			}
		]
	})

/**
 * The configuration's connection, generated refuses a connection that throws at stage config, holding what it threw,
 * stating an Error's message and never the password.
 *
 * Budget: its suite's count before the conversion (unit/cli/connection-threw: 100 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theConfigurationsConnectionGeneratedRefusesAConnectionThatThrowsAtStageConfigHoldingWhatItThrewStatingAnErrorsMessageAndNeverThePassword =
	property.explore(
		(source) =>
			[source.draw(element(thrownKinds)), source.draw(textPart), source.draw(drawnGen)] as const,
		{
			needs: {},
			situations: thrownKinds satisfies ReadonlyArray<Reached<ThrownKind>>,
			check:
				(_, c: Case<ThrownKind>) =>
				([kind, said, d]) =>
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
					}),
			oracle: {
				kind: "specification",
				name: "what a refusal states of a thrown value (cli/errors.ts Said), and the value itself"
			},
			budget: { runs: 100, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/errors.ts",
					original: '\tError.isError(value) && "_tag" in value && value._tag === "CompileError"',
					replacement: '\tError.isError(value) && "_tag" in value',
					why: 'Operator mutant (conjunct) at packages/engine/src/core/errors.ts:1015 in isCompileError: `Error.isError(value) && "_tag" in value && value._tag === "CompileError"` becomes `Error.isError(value) && "_tag" in value`; the property fails (lane CATCH, grizzle 0baff5d6).'
				}
			]
		}
	)

/**
 * The migration's process environment, generated refuses at stage environment exactly the environments that set
 * PGREPLICATION, naming it, and admits one that sets PGOPTIONS, which reaches no owner's session: each sets its own
 * options, generic plans (physical/ddl/roles.ts ownerStartupOptions).
 *
 * Budget: its suite's count before the conversion (unit/cli/owner-environment: 100 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theMigrationsProcessEnvironmentGeneratedRefusesAtStageEnvironmentExactlyTheEnvironmentsThatSetPGREPLICATION =
	property.explore(
		(source): OwnerEnvironment => ({
			PGOPTIONS: source.draw(variableGen),
			PGREPLICATION: source.draw(variableGen)
		}),
		{
			needs: {},
			situations: [
				"refused PGREPLICATION",
				"refused PGREPLICATION beside PGOPTIONS set",
				"admitted with PGOPTIONS set",
				"admitted with a variable empty",
				"admitted with neither set"
			] satisfies ReadonlyArray<Reached<OwnerEnvironmentFeature>>,
			check: (_, c: Case<OwnerEnvironmentFeature>) => (e) =>
				Effect.gen(function* () {
					const result = yield* Effect.scoped(
						Effect.andThen(
							processEnvironment(
								Rec.fromEntries(
									Arr.map(startupVariableNames, (name) => [name, processValue(e[name])] as const)
								)
							),
							Effect.result(ownerEnvironment)
						)
					)
					if (e.PGREPLICATION.kind !== "text") {
						succeeded(result, "an environment that sets no PGREPLICATION")
						c.note(
							e.PGOPTIONS.kind === "text"
								? "admitted with PGOPTIONS set"
								: Arr.some(startupVariableNames, (name) => e[name].kind === "empty")
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
					assert.equal(refused.reason.variable, "PGREPLICATION")
					lacksText(reported(refused), valueMark, "the refusal holds a value")
					c.note("refused PGREPLICATION")
					if (e.PGOPTIONS.kind === "text") {
						c.note("refused PGREPLICATION beside PGOPTIONS set")
					}
				}),
			oracle: {
				kind: "specification",
				name: "an environment that sets PGREPLICATION to a text is refused, its value never quoted, and PGOPTIONS admitted"
			},
			budget: { runs: 100, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/connection/environment.ts",
					original: '\t"PGREPLICATION"\n',
					replacement: '\t"PGOPTIONS",\n\t"PGREPLICATION"\n',
					why: "An owner's environment refused for PGOPTIONS, which reaches none of its sessions now that each sets its own options."
				}
			]
		}
	)
