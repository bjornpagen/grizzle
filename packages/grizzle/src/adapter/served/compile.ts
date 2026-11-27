import { openApiText } from "@bjornpagen/grizzle-openapi/openapi"
import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { Array as Arr, Effect, Option } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import {
	artifactsUnder,
	type LayerRole,
	loginChangesOver,
	type LoginInput,
	plannedLoginRoles,
	workloadReach
} from "#adapter/served/login.ts"
import { servedFileOf, type UncoveredProgram } from "#adapter/served/project.ts"
import { lawsAbove } from "#adapter/witness/keylaw.ts"
import {
	type ChangeRefused,
	programsOn,
	type RoleChanges,
	type ServableRole,
	servableRoles,
	variantsEntries
} from "#compiler/plan/change.ts"
import {
	type ClockSource,
	type CompileError,
	type InstalledArtifacts,
	type InstalledSource,
	type Isolation,
	levelChain,
	type LoginDesc,
	movedClock,
	type OwnedLogin,
	servedRecordsOf,
	transactionClock
} from "#compiler/plan/common.ts"
import {
	judgeSeeks,
	loginFootprints,
	type ProgramFootprints,
	type SeekTargets,
	seekProgram,
	servedText,
	type UnservedMember,
	type WorkloadPlanRefused
} from "#compiler/plan/migration.ts"
import {
	type ServedRecords,
	type ServedSnapshot,
	servedSnapshot,
	type UncoveredRead
} from "#compiler/plan/serve.ts"

/**
 * A login of a configured schema, as generate and check compile it: the login read where it was given (login.ts
 * LoginInput), from its value or its Description, and the login owned over its base.
 */
export interface ServedInput {
	readonly login: LoginInput
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
 * read and write (schema/reach.ts footprintOf, login.ts workloadReach), and each query program's
 * footprint, by name, as the workload plan read it (program/workload/compile.ts WorkloadFootprints), which its served
 * read routes changes by on every role it runs on.
 */
export interface CompiledServed {
	readonly login: LoginDesc
	readonly snapshot: ServedSnapshot
	readonly roles: ReadonlyArray<LayerRole>
	readonly footprint: ReadonlySet<string>
	readonly footprints: ProgramFootprints
	/** The records its base lists over its footprint (served/forms.ts ServedFile records). */
	readonly records: ReadonlyMap<string, ServedRecords>
}

/**
 * A login compiled under a snapshot alone (snapshotCompiled): its served compile, and each of its roles with its
 * ChangeSets as they compiled, whole (program/workload/change.ts RoleChanges), its compiled writes' put choices and
 * schedules among them, which a test reads beside the file its served compile projects, by the role's name in the
 * login.
 */
export interface SnapshotCompiled extends CompiledServed {
	readonly changes: ReadonlyMap<string, RoleChanges<Isolation, InstalledSource>>
}

const atLogin = (error: CompileError | UnservedMember): ServedRefusal => ({
	place: { kind: "login" },
	error
})

/**
 * Where a login's compile places its workload plan's refusal (program/workload/compile.ts WorkloadPlanRefused): one
 * program's at the program, on the first role of the login, in its order, that its workload runs on (programsOn), where
 * that role's own compile of its workload would refuse it; the plan's own, and a program of a workload no role of the
 * login runs, at the login.
 */
export const planRefusal = (login: ServedInput, refused: WorkloadPlanRefused): ServedRefusal => {
	if (refused.kind === "plan") {
		return atLogin(refused.error)
	}
	return Option.match(
		Arr.findFirst(login.login.roles, (role) => {
			const running = programsOn(role, [refused.workload])
			return running.ok && running.value.length > 0
		}),
		{
			onNone: () => atLogin(refused.error),
			onSome: (runs) => ({
				place: { kind: "program", role: runs.desc.name, program: refused.program },
				error: refused.error
			})
		}
	)
}

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
 * baseArtifacts), every program of the login's workloads that runs on the role once, so no law model is compiled for
 * the login. Its ChangeSets are
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
	artifacts: InstalledArtifacts,
	changes: ReadonlyMap<string, ServableRole<Isolation, InstalledSource>>,
	footprints: ProgramFootprints,
	clock: ClockSource
): Effect.fn.Return<CompiledServed, ServedRefusal> {
	const served = yield* Effect.mapError(
		fromEngine(servedSnapshot(snapshot, levelChain(login.login.base.desc).length - 1)),
		atLogin
	)
	const roles = yield* Effect.mapError(
		plannedLoginRoles(login.login, changes, artifacts, lawsAbove(served), clock),
		atRole
	)
	const { footprint } = yield* Effect.mapError(workloadReach(login.login, login.owned), atRole)
	return {
		login: login.login.desc,
		snapshot: served,
		roles,
		footprint,
		footprints,
		records: servedRecordsOf(login.login.relations, footprint)
	}
})

/**
 * A login's served file, as generate writes it to `served/<login>.json`: its login's declared name and the canonical
 * text (served/json.ts servedText) of the served file its compile is (compileServed, then adapter/served/project.ts
 * servedFileOf); and the login's OpenAPI document, read off that file alone (packages/openapi/src/openapi.ts
 * openApiText), which generate writes to `openapi/<login>.json`. check compares both byte for byte. The served file's
 * value is no part of it: what reads a login's file reads its text, and the value dies once its texts are made, where an
 * entry held it beside them until every login's was written (metis's suite installation: the served round grew by about
 * 730 MiB over its 28 logins, its largest file's text 83 MB).
 */
export interface ServedEntry {
	readonly login: string
	/** The served file's text and the OpenAPI document's, each as its chunks (grizzle-text TextChunks), never joined. */
	readonly text: TextChunks
	readonly openapi: TextChunks
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
 * The served file a login's compile projects (adapter/served/project.ts servedFileOf), with its canonical text and its
 * OpenAPI document's: what generate writes and an application's DbLayer serves, so a live read whose footprint its
 * snapshot's live source does not decode is refused, and an answered one, which no change wakes, needs none of it.
 */
export const servedEntryOf = Effect.fn("servedEntryOf")(function* (compiled: CompiledServed) {
	const file = yield* Effect.mapError(Effect.fromResult(servedFileOf(compiled)), projectionRefusal)
	const text = yield* Effect.mapError(fromEngine(servedText(file)), atLogin)
	const openapi = yield* Effect.mapError(fromEngine(openApiText(file)), atLogin)
	return { login: compiled.login.name, text, openapi }
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
	artifacts: InstalledArtifacts,
	changes: ReadonlyMap<string, ServableRole<Isolation, InstalledSource>>,
	footprints: ProgramFootprints,
	seeks: SeekTargets
): Effect.Effect<ServedEntry, ServedRefusal> =>
	Effect.flatMap(
		compileServed(login, snapshot, artifacts, changes, footprints, transactionClock),
		(compiled) => {
			judgeServedSeeks(compiled, changes, seeks)
			return servedEntryOf(compiled)
		}
	)

/**
 * Every read and write a login's served file sends held to the indexes of the installation it is drafted beside, `seeks`
 * (engine physical/access/seeks.ts judgeSeeks): each statement of each read, key and page of every role's workload, both
 * forms of a chosen one, read into its seek program here (engine sql/seeks.ts seekProgram), and each variant of each
 * change member of every role, `changes`, by the program its compile read off its statements before the installation
 * existed (engine write/program/served.ts ServableWrite `seeks`). A read or a write no index serves is an internal
 * compiler error of generate's, never a scan found where the file is served.
 */
const judgeServedSeeks = (
	compiled: CompiledServed,
	changes: ReadonlyMap<string, ServableRole<Isolation, InstalledSource>>,
	seeks: SeekTargets
): void => {
	for (const role of compiled.roles) {
		for (const form of role.workload) {
			if (form.kind === "change") {
				continue
			}
			const templates =
				form.kind === "paged"
					? [form.form.bound.compiled.compiled.template, form.form.page.compiled.template]
					: [form.form.bound.compiled.compiled.template]
			judgeSeeks(
				seekProgram(
					Arr.flatMap(templates, (t) => {
						const statement = t.run.statement
						return statement.forms.kind === "chosen"
							? [statement.ast, statement.forms.large.statement.ast]
							: [statement.ast]
					})
				),
				seeks,
				`the read ${form.name} of role ${role.role.name} of login ${compiled.login.name}`
			)
		}
	}
	for (const [name, role] of changes) {
		for (const [member, variants] of role.members) {
			for (const entry of variantsEntries(variants)) {
				judgeSeeks(
					entry.compiled.seeks,
					seeks,
					`the write ${member} of role ${name} of login ${compiled.login.name}`
				)
			}
		}
	}
}

/**
 * The compile of `login` under `snapshot` alone, no installation compiled beside it: the installation's artifacts
 * compiled from what the snapshot records (its codes, its closed relations' constant names, its text domains, its
 * foreign key graph's cycles and the types it casts its served parameters to) over every relation, the law model
 * generate compiles from the schema, then the login over them (compileServed), its query programs' footprints as its
 * workload's plan reads them (loginFootprints, which plans no ChangeSet: the login's compile compiled them), every reading of the clock its clocked reads and ChangeSets make counting from
 * `clock`: its roles, each with its workload's programs compiled, which a test reads beside the file they project (a
 * change form's compiled entry, its put choices among it). A program that casts a parameter to a type the snapshot's
 * installation does not install is refused at its role and program as UninstalledDomain.
 */
export const snapshotCompiled = Effect.fn("snapshotCompiled")(function* (
	login: ServedInput,
	snapshot: unknown,
	clock: ClockSource
): Effect.fn.Return<SnapshotCompiled, ServedRefusal> {
	const served = yield* Effect.mapError(
		fromEngine(servedSnapshot(snapshot, levelChain(login.login.base.desc).length - 1)),
		atLogin
	)
	const base = login.owned.base
	const reach = yield* Effect.mapError(workloadReach(login.login, login.owned), atRole)
	const artifacts = yield* Effect.mapError(
		fromEngine(
			artifactsUnder(
				base,
				served.codes,
				served.derived,
				{ kind: "recorded", installed: served.derived.params },
				{ kind: "analyzed" },
				reach.served
			)
		),
		atLogin
	)
	const changes = yield* Effect.mapError(
		loginChangesOver(login.login, login.owned, artifacts, "serializable", clock),
		atRole
	)
	const footprints = yield* Effect.mapError(
		fromEngine(loginFootprints(login.login.workload, login.login.base, artifacts)),
		(refused) => planRefusal(login, refused)
	)
	const compiled = yield* compileServed(
		login,
		snapshot,
		artifacts,
		servableRoles(changes),
		footprints,
		clock
	)
	return { ...compiled, changes }
})

/**
 * The served file of `login` under `snapshot` alone (`snapshotCompiled`, then `servedEntryOf`), every reading of the
 * clock the transaction's: an application's test's compile (adapter/public/compile.ts compileServed).
 */
export const snapshotServedEntry = (
	login: ServedInput,
	snapshot: unknown
): Effect.Effect<ServedEntry, ServedRefusal> =>
	Effect.flatMap(snapshotCompiled(login, snapshot, transactionClock), servedEntryOf)

/**
 * The served file of `login` under `snapshot` alone (`snapshotCompiled`, then `servedEntryOf`), every reading of the
 * clock its clocked reads and ChangeSets make the clock's stated instant, which each of them declares and a Db over a
 * moved clock states at each call (adapter/db/moved.ts): adapter/public/compile.ts compileServedMoved's.
 */
export const snapshotMovedEntry = (
	login: ServedInput,
	snapshot: unknown
): Effect.Effect<ServedEntry, ServedRefusal> =>
	Effect.flatMap(snapshotCompiled(login, snapshot, movedClock), servedEntryOf)
