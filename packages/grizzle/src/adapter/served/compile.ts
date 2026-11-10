import { Array as Arr, Effect } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import {
	artifactsUnder,
	type BuiltLogin,
	type LayerRole,
	loginChangesOver,
	plannedLoginRoles
} from "#adapter/served/login.ts"
import { type LeveledRole, servedFileOf } from "#adapter/served/project.ts"
import { lawsAbove } from "#adapter/witness/keylaw.ts"
import type { ChangeRefused, RoleChanges } from "#compiler/plan/change.ts"
import {
	type CompileError,
	Engine,
	type Isolation,
	levelChain,
	type LoginDesc,
	type OwnedLogin,
	type SchemaArtifacts
} from "#compiler/plan/common.ts"
import { servedText, type UnservedMember } from "#compiler/plan/migration.ts"
import {
	everySlice,
	type ServedFile,
	type ServedSnapshot,
	servedSnapshot
} from "#compiler/plan/serve.ts"

/** A login of a configured schema, as generate and check compile it: its value, and the login owned over its base. */
export interface ServedInput {
	readonly login: BuiltLogin
	readonly owned: OwnedLogin
}

/**
 * Where the compile of a login's workload refused: the login itself (the snapshot it compiles under, or its served
 * file), one of its roles (the role's artifacts, contexts or PostgreSQL role), or one program of a role.
 */
export type WorkloadPlace =
	| { readonly kind: "login" }
	| { readonly kind: "role"; readonly role: string }
	| { readonly kind: "program"; readonly role: string; readonly program: string }

/**
 * The compile of a login's workload refused, at `place`, for `error`: a CompileError, or a workload ChangeSet no served
 * file can hold, with every reason (served/unserved.ts UnservedMember).
 */
export interface ServedRefusal {
	readonly place: WorkloadPlace
	readonly error: CompileError | UnservedMember
}

/**
 * A login's workload compiled: the login, the snapshot it compiled under, read over the login's base's level, and every
 * role of it with its programs, in the login's order.
 */
export interface CompiledServed {
	readonly login: LoginDesc
	readonly snapshot: ServedSnapshot
	readonly roles: ReadonlyArray<LeveledRole>
}

/**
 * The isolation level each role of a login's compile begins its writes at, by the role's declared name: its certificate's
 * where the draft's workload plan certified it over the installation's writers (program/isolation/certification.ts),
 * and SERIALIZABLE for a compile of other programs than the installation certified (`uncertified`).
 */
export type LevelOf = (role: string) => Isolation

/** Every role SERIALIZABLE: the level of a compile no certificate covers, the snapshot-only compile's. */
const uncertified: LevelOf = () => "serializable"

/** Each role of a login's compile at the level `levelOf` gives it. */
const leveled = (roles: ReadonlyArray<LayerRole>, levelOf: LevelOf): ReadonlyArray<LeveledRole> =>
	Arr.map(roles, (role): LeveledRole => ({ ...role, isolation: levelOf(role.role.name) }))

const atLogin = (error: CompileError | UnservedMember): ServedRefusal => ({
	place: { kind: "login" },
	error
})

/** A refusal of the login's compile, at the role and the program it names (adapter/served/login.ts). */
export const atRole = (refused: ChangeRefused): ServedRefusal => ({
	place:
		refused.program === undefined
			? { kind: "role", role: refused.role }
			: { kind: "program", role: refused.role, program: refused.program },
	error: refused.error
})

/**
 * The one compile of a login's workload: what `grizzle generate` writes to `migrations/<schema>/served/<login>.json`,
 * what `grizzle check` compiles again and holds the committed file to, byte for byte, and what an application's
 * DbLayer serves. Nothing a login's runtime loads imports it (fallow's adapter-install zone).
 *
 * `login` compiles under `snapshot`, the JSON value of the snapshot.json it is committed beside, as an import of the
 * file yields it, read as DbLayer.make read it (deploy/snapshot/served.ts servedSnapshot) over the login's base's level,
 * the last of its own levels: its recorded codes and the laws of the levels above the login's base. Every role of the
 * login compiles over `artifacts`, its base's, compiled under those codes over every relation (program/schema.ts
 * baseArtifacts), every program of the login's workloads that runs on the role once: a program compiles over the whole
 * installation's artifacts exactly as over its slice's, so no law model is compiled for the login. Its ChangeSets are
 * the login's change compile's, `changes`, compiled once over the same artifacts (program/workload/change.ts
 * loginChanges). A role's refusals are cut to what its programs' writes can raise (served/project.ts).
 * generate and check both compile from the snapshot.json text the draft lays out, so the drafted snapshot and the
 * committed one are one input, and a login compiles to one served file.
 */
const compileServed = Effect.fn("compileServed")(function* (
	login: ServedInput,
	snapshot: unknown,
	artifacts: SchemaArtifacts,
	changes: ReadonlyMap<string, RoleChanges>,
	levelOf: LevelOf
): Effect.fn.Return<CompiledServed, ServedRefusal> {
	const served = yield* Effect.mapError(
		fromEngine(servedSnapshot(snapshot, levelChain(login.login.base.desc).length - 1)),
		atLogin
	)
	const layer = { slice: everySlice(login.owned.base), artifacts, over: () => Engine.ok(artifacts) }
	const roles = yield* Effect.mapError(
		plannedLoginRoles(login.login, changes, layer, lawsAbove(served)),
		atRole
	)
	return { login: login.login.desc, snapshot: served, roles: leveled(roles, levelOf) }
})

/**
 * A login's served file, as generate writes it to `served/<login>.json`: its login's declared name, the served file its
 * compile is (compileServed, then adapter/served/project.ts servedFileOf), and that value's canonical text
 * (served/json.ts servedText), which check compares byte for byte.
 */
export interface ServedEntry {
	readonly login: string
	readonly file: ServedFile
	readonly text: string
}

/** The served file a login's compile projects (adapter/served/project.ts servedFileOf), with its canonical text. */
export const servedEntryOf = Effect.fn("servedEntryOf")(function* (compiled: CompiledServed) {
	const file = yield* Effect.fromResult(servedFileOf(compiled))
	const text = yield* fromEngine(servedText(file))
	return { login: compiled.login.name, file, text }
}, Effect.mapError(atLogin))

/**
 * The served file of `login` under `snapshot`, the JSON value of the snapshot.json beside it, compiled over its base's
 * artifacts `artifacts`, its ChangeSets as `changes` compiled them over those artifacts, each role at the level `levelOf`
 * gives it (compileServed, then `servedEntryOf`).
 */
export const servedEntry = (
	login: ServedInput,
	snapshot: unknown,
	artifacts: SchemaArtifacts,
	changes: ReadonlyMap<string, RoleChanges>,
	levelOf: LevelOf
): Effect.Effect<ServedEntry, ServedRefusal> =>
	Effect.flatMap(compileServed(login, snapshot, artifacts, changes, levelOf), servedEntryOf)

/**
 * The compile of `login` under `snapshot` alone, no installation compiled beside it: the installation's artifacts
 * compiled from what the snapshot records (its codes, its closed relations' constant names, its text domains and its
 * foreign key graph's cycles) over every relation, the law model generate compiles from the schema, then the login over
 * them (compileServed): its roles, each with its workload's programs compiled, which a test reads beside the file they
 * project (a change form's compiled entry, its put choices among it).
 */
export const snapshotCompiled = Effect.fn("snapshotCompiled")(function* (
	login: ServedInput,
	snapshot: unknown
): Effect.fn.Return<CompiledServed, ServedRefusal> {
	const served = yield* Effect.mapError(
		fromEngine(servedSnapshot(snapshot, levelChain(login.login.base.desc).length - 1)),
		atLogin
	)
	const base = login.owned.base
	const { artifacts } = yield* Effect.mapError(
		fromEngine(artifactsUnder(base, served.codes, served.derived, everySlice(base))),
		atLogin
	)
	const changes = yield* Effect.mapError(
		loginChangesOver(login.login, login.owned, artifacts),
		atRole
	)
	return yield* compileServed(login, snapshot, artifacts, changes, uncertified)
})

/**
 * The served file of `login` under `snapshot` alone (`snapshotCompiled`, then `servedEntryOf`): an application's test's
 * compile (adapter/public/compile.ts compileServed).
 */
export const snapshotServedEntry = (
	login: ServedInput,
	snapshot: unknown
): Effect.Effect<ServedEntry, ServedRefusal> =>
	Effect.flatMap(snapshotCompiled(login, snapshot), servedEntryOf)
