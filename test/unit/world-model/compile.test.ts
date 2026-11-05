import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required, type Situations } from "@grizzle/testing/features"
import { boolean, element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Engine from "#compiler/core/result.ts"
import { assert, defined } from "#test/support/assert.ts"
import { atDeclaredName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import { namesOfBuilt } from "#test/support/worlds/execute/names.ts"
import { offlineCompile, parsedChange } from "#test/support/worlds/execute/offline.ts"
import { plannedWrite } from "#test/support/worlds/execute/session.ts"
import { additionsOf } from "#test/support/worlds/features.ts"
import { actionGen } from "#test/support/worlds/generate/action.ts"
import { contextsRead } from "#test/support/worlds/generate/entries.ts"
import { defaultScope } from "#test/support/worlds/generate/enumerate.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import {
	everyActionWorth,
	type Weights,
	weightsGen,
	zeroWeights
} from "#test/support/worlds/generate/weights.ts"
import { liveFactsGen } from "#test/support/worlds/invalid/tokens.ts"
import { docsBase, docsVisitsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { serialHead, writtenOf } from "#test/support/worlds/model/session/writes.ts"
import { initialState, settle, step } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	ActionOutcome,
	AdditionFeature,
	DbSessionState,
	InstallSpec,
	ModelState,
	RoleSpec
} from "#test/support/worlds/model/types.ts"

/**
 * The worlds model's oracle on a write's compile phase alone, with no PostgreSQL: over an installation of the documents
 * base built through the public builders, a lawful reality and a Db of one of its roles (a writing one where the
 * installation holds any), one `db.apply` the worlds suites draw for that Db (generate/action.ts actionGen, its kinds
 * cut to apply under drawn validity weights, so its stale and wild facts and relations come along). The ChangeSet is
 * the one the executor hands to db.apply (execute/session.ts plannedWrite), compiled with compileWrite against the
 * role's artifacts and the Db's claims as adapter/apply/compile.ts writeEntry compiles it. It compiles exactly where
 * the model's outcomes for the action exclude `compile-refused`, and the model refuses it when it compiles on every
 * branch or on none.
 *
 * Every refusal over a write the model admits fails here, whatever its kind, so a description the compiler builds for
 * itself and then refuses (the class of a generated addition through an entry whose every carried field is serial)
 * is caught on every seed of the unit tier. Required: both verdicts, and the additions the model admits whose every
 * carried field is serial (through a query entry, and into the base's every-serial relation written whole), complete
 * and generated, and generated ones beside carried fields. A witness aims at the additions no witness reached yet
 * (additionAim).
 */
type CompileFeature = "compiled" | "compile-refused" | AdditionFeature

/** The additions the suite requires. */
const additions: Arr.NonEmptyReadonlyArray<AdditionFeature> = [
	"addition:complete:entry:unit",
	"addition:generated:entry:unit",
	"addition:complete:whole:unit",
	"addition:generated:whole:unit",
	"addition:generated:entry:carried",
	"addition:generated:whole:carried"
]

const situations: Situations<CompileFeature> = ["compiled", "compile-refused", ...additions]

/**
 * The additions a witness aims at, in half its cases by a draw of its own: those no witness reached yet (Case.steering).
 * None for a rotating or kept case, which runs as drawn.
 */
const additionAim = (
	c: Case<CompileFeature>
): Option.Option<Arr.NonEmptyReadonlyArray<AdditionFeature>> => {
	const pending = Option.match(c.steering, {
		onNone: (): ReadonlyArray<AdditionFeature> => [],
		onSome: (p) => Arr.filter(additions, (f) => p.has(f))
	})
	return Arr.isReadonlyArrayNonEmpty(pending) && c.draw(boolean)
		? Option.some(pending)
		: Option.none()
}

/**
 * The installation an aimed witness writes under: the documents base's worlds whose roles write Visit whole (the
 * admin), through a query entry whose every carried field is serial, one filtering on a serial field and one fixing one
 * (docsVisitsInstall), beside the member's notes, whose number is serial; the drawn one otherwise, whose roles hold
 * those shapes too rarely to rely on.
 */
const aimedInstall = (
	aim: Option.Option<Arr.NonEmptyReadonlyArray<AdditionFeature>>,
	drawnInstall: InstallSpec
): InstallSpec => (Option.isSome(aim) ? docsVisitsInstall : drawnInstall)

/**
 * Whether a role writes a relation, whole or through a query entry, with a serial field a fact may leave out
 * (model/session/writes.ts serialHead): a role whose writes reach a generated addition of either target.
 */
const leavesOutSerials = (install: InstallSpec, role: RoleSpec): boolean =>
	Arr.some(writtenOf(install.base, role), (w) => serialHead(install.base, w).classed.length > 0)

/** What an apply notes where the model admits it past its compile: its additions (features.ts additionsOf). */
const compiledAdditions = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<string> =>
	action.kind === "apply" && observation.kind !== "compile-refused"
		? additionsOf(state, action)
		: []

/** A compile's refusal; none when it compiles. */
const refusalOf = <A>(compiled: Engine.Result<A, CompileError>): CompileError | undefined =>
	compiled.ok ? undefined : compiled.error

/** A run's weights cut to applies: every other kind off, its validity shares as drawn. */
const appliesOnly = (weights: Weights): Weights => ({
	...weights,
	actions: { ...zeroWeights.actions, apply: 1 },
	kinds: ["apply"]
})

describe("the worlds model's compile rules", () => {
	it.effect("compile a write exactly where the model admits it past its compile", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/world-model/compile",
					draw: drawn(installGen(docsBase)),
					literal: Formatter.format,
					coverage: required<CompileFeature>(situations, { cases: 120, sense: notesOnly }),
					kept: [],
					runs: 80,
					shrink: { kind: "bounded", candidates: 200 },
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(drawnInstall, c) =>
					Effect.gen(function* () {
						const aim = additionAim(c)
						const install = aimedInstall(aim, drawnInstall)
						const built = yield* Effect.orDie(buildInstall(install, install.base.name))
						const names = yield* namesOfBuilt(install, built, atDeclaredName)
						const host = hostSchemaOf(install.base, names)
						const loaded = initialState(install, names, c.draw(realityGen(install.base, host)))
						const writers = Arr.filter(install.roles, (r) => r.write.length > 0)
						const leaving = Arr.filter(writers, (r) => leavesOutSerials(install, r))
						const role = c.draw(
							element(
								Option.isSome(aim) && Arr.isReadonlyArrayNonEmpty(leaving)
									? leaving
									: Arr.isReadonlyArrayNonEmpty(writers)
										? writers
										: install.roles
							)
						)
						const login = defined(
							Option.getOrUndefined(
								Arr.findFirst(install.logins, (l) => l.roles.includes(role.name))
							),
							`a login holding ${role.name}`
						)
						const session: DbSessionState = {
							kind: "db",
							login: login.name,
							role: role.name,
							facts: c.draw(liveFactsGen(loaded, contextsRead(install.base, role))),
							connection: 0,
							snapshot: { version: loaded.version, install, names, host }
						}
						const state: ModelState = { ...loaded, sessions: [session] }
						const weights = appliesOnly(c.draw(weightsGen))
						const action = c.draw(
							actionGen(
								state,
								Option.match(aim, {
									onNone: () => weights,
									onSome: (features): Weights => ({
										...weights,
										aims: {
											kind: "every",
											features,
											read: compiledAdditions,
											worth: everyActionWorth,
											scope: defaultScope
										}
									})
								})
							)
						)
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
						const refusal: CompileError | undefined = Result.isFailure(write)
							? write.failure
							: refusalOf(
									offlineCompile(
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
					})
			)
		)
	)
})
