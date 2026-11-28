/**
 * The worlds model's oracle on a write's compile phase alone, with no PostgreSQL: over an installation of the documents
 * base built through the public builders, a lawful reality and a Db of one of its roles (a writing one where the
 * installation holds any), one apply the worlds suites draw for that Db (generate/action.ts actionGen, its kinds
 * cut to apply under drawn validity weights, so its stale and wild facts and relations come along). The ChangeSet is
 * the one the executor serves (execute/session.ts plannedWrite), compiled with compileWrite against the role's
 * artifacts under every context's claims, as the workload's plan compiles it, then under the Db's, and its array
 * members served as a call supplies them (execute/offline.ts offlineServed), as the served compile compiles it. It
 * compiles exactly where the model's outcomes for the action exclude `compile-refused`, and the model refuses it when it
 * compiles on every branch or on none.
 *
 * Every refusal over a write the model admits fails here, whatever its kind, so a description the compiler builds for
 * itself and then refuses is caught on every seed of the unit tier. Required: both verdicts, and the additions the
 * model admits, through a query entry and written whole. A witness whose turn aims at an addition no witness reached
 * yet writes under the documents base's README-shaped worlds, its action aimed at it (sketchSpace).
 *
 * The oracle is a second implementation: the worlds model's compile rules against grizzle's compile of the write the
 * executor serves.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { UnservedMember } from "#compiler/served/unserved.ts"
import { atDeclaredName } from "#test/support/kernel/naming.ts"
import { messageOf } from "#test/support/message.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import { namesOfBuilt } from "#test/support/worlds/execute/names.ts"
import { offlineServed, parsedChange } from "#test/support/worlds/execute/offline.ts"
import { plannedWrite } from "#test/support/worlds/execute/session.ts"
import { additionsOf } from "#test/support/worlds/features.ts"
import { actionGen } from "#test/support/worlds/generate/action.ts"
import { contextsRead } from "#test/support/worlds/generate/entries.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import { weightsGen } from "#test/support/worlds/generate/weights.ts"
import { liveFactsGen } from "#test/support/worlds/invalid/tokens.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { initialState, settle, step } from "#test/support/worlds/model/step.ts"
import type { DbSessionState, ModelState } from "#test/support/worlds/model/types.ts"
import {
	aimedWeights,
	appliesOnly,
	type CompileFeature,
	installOf,
	refusalOf,
	situations,
	sketchSpace
} from "#test/unit/world-model/compile.fixtures.ts"

/**
 * The worlds model's compile rules compile a write exactly where the model admits it past its compile.
 *
 * Budget: its suite's count before the conversion (unit/world-model/compile: 80 independent cases and 16 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theWorldsModelsCompileRulesCompileAWriteExactlyWhereTheModelAdmitsItPastItsCompile =
	property.explore(sketchSpace, {
		needs: {},
		situations: situations,
		check: (_, c: Case<CompileFeature>) => (sketch) =>
			Effect.gen(function* () {
				const install = installOf(sketch)
				const built = yield* Effect.orDie(buildInstall(install, install.base.name))
				const names = yield* namesOfBuilt(install, built, atDeclaredName)
				const host = hostSchemaOf(install.base, names)
				const loaded = initialState(install, names, c.draw(realityGen(install.base, host)))
				const writers = Arr.filter(install.roles, (r) => r.write.length > 0)
				const role = c.draw(element(Arr.isReadonlyArrayNonEmpty(writers) ? writers : install.roles))
				const login = defined(
					Option.getOrUndefined(Arr.findFirst(install.logins, (l) => l.roles.includes(role.name))),
					`a login holding ${role.name}`
				)
				const session: DbSessionState = {
					kind: "db",
					login: login.name,
					role: role.name,
					facts: c.draw(liveFactsGen(loaded, contextsRead(install.base, role))),
					claims: "admitted",
					connection: 0,
					snapshot: { version: loaded.version, install, names, host },
					guard: "held"
				}
				const state: ModelState = { ...loaded, sessions: [session] }
				const weights = appliesOnly(c.draw(weightsGen))
				const action = c.draw(actionGen(state, aimedWeights(sketch, weights)))
				if (action.kind !== "apply") {
					return assert.fail(`an apply, not ${action.kind}`)
				}
				const branches = Arr.map(step(state, action), (s) => settle(s, () => names))
				const refused = Arr.filter(branches, (b) => b.observation.kind === "compile-refused")
				assert.ok(
					refused.length === 0 || refused.length === branches.length,
					`the model refuses ${Formatter.format(action)} when it compiles on some branches only`
				)
				const value = defined(built.roles[role.name], `the role ${role.name} as built`)
				const write = yield* plannedWrite(
					install.base,
					{ role, value },
					action.strata,
					action.reads
				)
				const refusal: CompileError | UnservedMember | undefined = Result.isFailure(write)
					? write.failure
					: refusalOf(
							offlineServed(
								value,
								parsedChange(write.success.changes),
								new Set(Rec.keys(session.facts))
							)
						)
				if (refused.length === 0) {
					if (refusal !== undefined) {
						return assert.fail(
							`the model admits ${Formatter.format(action)} past its compile, and grizzle refuses it: ${messageOf(refusal)}`
						)
					}
					c.note("compiled")
					c.noteAll(additionsOf(state, action))
					return
				}
				assert.ok(
					refusal !== undefined,
					`the model refuses ${Formatter.format(action)} when it compiles, and grizzle compiles it`
				)
				c.note("compile-refused")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the worlds model's compile rules, against grizzle's served compile of the write"
		},
		budget: { runs: 80, steered: 16 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/world-model/compile.test.ts#theWorldsModelsCompileRulesCompileAWriteExactlyWhereTheModelAdmitsItPastItsCompile:-:0.1.0.1.0.0.0.1.1.0.0.0.1.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.1.0.1.2.3q.0.0.0.0.0.1.0.0.1.1.0.0.1.1.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.1.0.0.0.0.1.1.0.0.0.1"
				),
				reason:
					"an insert through View0 then its delete in a stratum of its own, both sides of View0's delta read back, by a session whose claims hold no Tenant, the context View0 fills its doc from: the served member is planned under every context's claims, where both strata write Share, so grizzle refuses its read-backs as crossing statements for every caller, as the model does (NEGZERO2's replay at 46905a719 compiled it under the session's claims alone)",
				since: "2026-11-20"
			},
			{
				token: ReplayToken(
					"test/unit/world-model/compile.test.ts#theWorldsModelsCompileRulesCompileAWriteExactlyWhereTheModelAdmitsItPastItsCompile:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.fuz.242.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.2.0.0.0.1.1"
				),
				reason:
					"a put of one Doc read back, Doc keyed on (org, words) beside its id: the put split by its unique values (uniqueSplit) made its added rows two statements', its update's and its insert half's, and generate refused the read-back (ReadBackCrossesStatements), a served put refused (lane STRANGER at main 74cca52e)",
				since: "2026-11-28"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/put/choose.ts",
				original: '\t\t\t\t\t\treturn primary.kind === "key" && !deltaRead.has(action.relation)\n',
				replacement: '\t\t\t\t\t\treturn primary.kind === "key"\n',
				why: "A put of a relation a read-back reads a delta of is split by its unique values: its added rows are its update's and its insert half's, two statements', and the compile refuses the read-back Doc's put serves."
			},
			{
				file: "packages/engine/src/core/errors.ts",
				original: '\tError.isError(value) && "_tag" in value && value._tag === "CompileError"',
				replacement: "\tfalse",
				why: 'Operator mutant (boolean-return) at packages/engine/src/core/errors.ts:1015 in isCompileError: `Error.isError(value) && "_tag" in value && value._tag === "CompileError"` becomes `false`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})
