import { Effect } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import {
	artifactsUnder,
	type BuiltLogin,
	type LayerRole,
	loginChangesOver,
	plannedLoginRoles,
	workloadSlice
} from "#adapter/served/login.ts"
import { type ReadsServed, servedFileOf, type UncoveredProgram } from "#adapter/served/project.ts"
import { lawsAbove } from "#adapter/witness/keylaw.ts"
import type { ChangeRefused, RoleChanges } from "#compiler/plan/change.ts"
import {
	type CompileError,
	defect,
	Engine,
	levelChain,
	type LoginDesc,
	noParamContracts,
	type OwnedLogin,
	type ParamContract,
	type SchemaArtifacts
} from "#compiler/plan/common.ts"
import {
	compileWorkload,
	openApiText,
	type ProgramFootprints,
	servedText,
	type UnservedMember
} from "#compiler/plan/migration.ts"
import {
	everySlice,
	type ServedFile,
	type ServedSnapshot,
	servedSnapshot,
	type UncoveredRead
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
 * The compile of a login's workload refused, at `place`, for `error`: a CompileError, a workload ChangeSet no served
 * file can hold, with every reason (served/unserved.ts UnservedMember), or a watched read whose footprint the
 * snapshot's live source does not decode, with every part of it the source does not (served/forms.ts UncoveredRead).
 */
export interface ServedRefusal {
	readonly place: WorkloadPlace
	readonly error: CompileError | UnservedMember | UncoveredRead
}

/**
 * A login's workload compiled: the login, the snapshot it compiled under, read over the login's base's level, every
 * role of it with its programs, in the login's order, its footprint, the declared names of the relations its programs
 * read and write (schema/reach.ts Slice names, its writes among them, login.ts workloadSlice), and each query program's
 * footprint, by name, as the workload plan read it (program/workload/compile.ts WorkloadFootprints), which its served
 * read routes changes by on every role it runs on.
 */
export interface CompiledServed {
	readonly login: LoginDesc
	readonly snapshot: ServedSnapshot
	readonly roles: ReadonlyArray<LayerRole>
	readonly footprint: ReadonlySet<string>
	readonly footprints: ProgramFootprints
}

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
 * the login's change compile's, `changes`, compiled once over the same artifacts at the level each role's writes run
 * at, its certificate's (program/workload/change.ts loginChanges, program/isolation/certification.ts), which its
 * served form records (login.ts LayerRole `isolation`). A role's refusals are cut to what its programs' writes can raise,
 * and the snapshot's installed tables to the login's footprint (served/project.ts).
 * generate and check both compile from the snapshot.json text the draft lays out, so the drafted snapshot and the
 * committed one are one input, and a login compiles to one served file.
 */
const compileServed = Effect.fn("compileServed")(function* (
	login: ServedInput,
	snapshot: unknown,
	artifacts: SchemaArtifacts,
	changes: ReadonlyMap<string, RoleChanges>,
	footprints: ProgramFootprints
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
	const footprint = yield* Effect.mapError(workloadSlice(login.login, login.owned), atRole)
	return {
		login: login.login.desc,
		snapshot: served,
		roles,
		footprint: footprint.names,
		footprints
	}
})

/**
 * A login's served file, as generate writes it to `served/<login>.json`: its login's declared name, the served file its
 * compile is (compileServed, then adapter/served/project.ts servedFileOf), and that value's canonical text
 * (served/json.ts servedText); and the login's OpenAPI document, read off that file alone (live/openapi.ts
 * openApiText), which generate writes to `openapi/<login>.json`. check compares both byte for byte.
 */
export interface ServedEntry {
	readonly login: string
	readonly file: ServedFile
	readonly text: string
	readonly openapi: string
}

/** A refusal of the projection: an uncovered read's at its program, any other at the login. */
const projectionRefusal = (
	refused: CompileError | UnservedMember | UncoveredProgram
): ServedRefusal =>
	refused._tag === "UncoveredProgram"
		? {
				place: { kind: "program", role: refused.role, program: refused.program },
				error: refused.read
			}
		: atLogin(refused)

/**
 * The served file a login's compile projects with its reads served as `reads` says (adapter/served/project.ts
 * servedFileOf), with its canonical text and its OpenAPI document's.
 */
const entryOf = (
	compiled: CompiledServed,
	reads: ReadsServed
): Effect.Effect<ServedEntry, ServedRefusal> =>
	Effect.gen(function* () {
		const file = yield* Effect.mapError(
			Effect.fromResult(servedFileOf(compiled, reads)),
			projectionRefusal
		)
		const text = yield* Effect.mapError(fromEngine(servedText(file)), atLogin)
		const openapi = yield* Effect.mapError(fromEngine(openApiText(file)), atLogin)
		return { login: compiled.login.name, file, text, openapi }
	})

/**
 * The served file of a login's compile, its reads called by `watch` and `once` (entryOf): what generate writes and an
 * application's DbLayer serves, so a read whose footprint its snapshot's live source does not decode is refused.
 */
export const servedEntryOf = Effect.fn("servedEntryOf")(function* (compiled: CompiledServed) {
	return yield* entryOf(compiled, "watched")
})

/**
 * The served file of a login's compile, its reads called by `once` alone (entryOf): one whose members a test serves
 * through adapter/db/handles.ts onceCalls, never a DbLayer, so its reads need no live source and it holds none.
 */
const onceEntryOf = Effect.fn("onceEntryOf")(function* (compiled: CompiledServed) {
	return yield* entryOf(compiled, "once")
})

/**
 * The served file of `login` under `snapshot`, the JSON value of the snapshot.json beside it, compiled over its base's
 * artifacts `artifacts`, its ChangeSets as `changes` compiled them over those artifacts, each role's at the level its
 * certificate gives it, and its read programs' footprints as `footprints` read them (compileServed, then
 * `servedEntryOf`).
 */
export const servedEntry = (
	login: ServedInput,
	snapshot: unknown,
	artifacts: SchemaArtifacts,
	changes: ReadonlyMap<string, RoleChanges>,
	footprints: ProgramFootprints
): Effect.Effect<ServedEntry, ServedRefusal> =>
	Effect.flatMap(compileServed(login, snapshot, artifacts, changes, footprints), servedEntryOf)

/**
 * The compile of `login` under `snapshot` alone, no installation compiled beside it: the installation's artifacts
 * compiled from what the snapshot records (its codes, its closed relations' constant names, its text domains and its
 * foreign key graph's cycles) over every relation, the law model generate compiles from the schema, its workload
 * planned over them (compileWorkload), whose query programs' footprints and parameters' contracts are the plan's, then
 * the login over those artifacts serving its parameters' contracts, as generate compiles it (compileServed): its roles,
 * each with its workload's programs compiled, which a test reads beside the file they project (a change form's compiled
 * entry, its put choices among it).
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
	const artifactsServing = (params: ReadonlyArray<ParamContract>) =>
		Effect.mapError(
			fromEngine(artifactsUnder(base, served.codes, served.derived, everySlice(base), params)),
			atLogin
		)
	const checking = yield* artifactsServing(noParamContracts)
	const name = login.login.desc.name
	const planned = yield* Effect.mapError(
		fromEngine(
			compileWorkload([{ login: name, workloads: login.login.workload }], login.login.base, {
				artifacts: checking.artifacts,
				roles: []
			})
		),
		atLogin
	)
	const footprints = planned.footprints.get(name)
	const params = planned.loginContracts.get(name)
	if (footprints === undefined || params === undefined) {
		throw defect(
			`the footprints and the parameters' contracts of login ${name}, the one login its workload plan plans`
		)
	}
	const { artifacts } = yield* artifactsServing(params)
	const changes = yield* Effect.mapError(
		loginChangesOver(login.login, login.owned, artifacts, "serializable"),
		atRole
	)
	return yield* compileServed(login, snapshot, artifacts, changes, footprints)
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

/**
 * The served file of `login` under `snapshot` alone, its reads called once alone (`snapshotCompiled`, then
 * `onceEntryOf`): adapter/public/compile.ts compileServedOnce's.
 */
export const snapshotOnceEntry = (
	login: ServedInput,
	snapshot: unknown
): Effect.Effect<ServedEntry, ServedRefusal> =>
	Effect.flatMap(snapshotCompiled(login, snapshot), onceEntryOf)
