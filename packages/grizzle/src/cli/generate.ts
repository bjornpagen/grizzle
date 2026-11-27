import { ChunkView, readJson, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	type PlatformError,
	Result,
	type Scope
} from "effect"
import { matchesFile } from "#adapter/boundary/files.ts"
import { fromEngine } from "#adapter/engine.ts"
import { atRole, type ServedEntry, servedEntry } from "#adapter/served/compile.ts"
import { artifactsOver, artifactsUnder, workloadReach } from "#adapter/served/login.ts"
import type { GenerateMode } from "#cli/args.ts"
import { committedSnapshot, continuedChain } from "#cli/committed.ts"
import {
	type CompiledSchema,
	type ConfiguredSchema,
	compileSchema,
	type ResolvedConfig
} from "#cli/config.ts"
import {
	type CliError,
	DraftRefused,
	MigrationsUnread,
	cliError,
	RosterReordered,
	SchemaChoiceRefused,
	ServedRefused,
	TreeUnread
} from "#cli/errors.ts"
import {
	commitFolder,
	commitLoginFiles,
	commitSnapshotFiles,
	type LoginFileKind,
	loginFileKinds,
	loginFiles,
	type LoginPaths,
	readSchemaTree,
	type Staging,
	stageFolder,
	stageLoginFile,
	stageSnapshotFiles,
	stagingArea,
	unsplitWithin,
	visibleEntries
} from "#cli/files.ts"
import { phasedEffect } from "#cli/phases.ts"
import { rosterRenames } from "#cli/renames.ts"
import { nextTimestamp } from "#cli/timestamp.ts"
import type { ServableRole } from "#compiler/plan/change.ts"
import {
	type Codebook,
	type CompileError,
	defect,
	draftCodebook,
	type PreviousRoster,
	type RosterRenames,
	type InstalledSource,
	type Isolation,
	namedLogin,
	type Phases,
	phased,
	unserved,
	rostersOf,
	sameLevel,
	transactionClock,
	unrepresentableKeys,
	type InstalledArtifacts,
	type QueryDesc,
	type SchemaContent,
	servedTogether
} from "#compiler/plan/common.ts"
import {
	type AbandonedSchema,
	planWorkload,
	completeInstallOptions,
	customMigration,
	type Declarations,
	derivedFacts,
	type DraftInput,
	draftMigration,
	findMarkers,
	type FolderNaming,
	generatedFileMaxBytes,
	type Installation,
	installationOver,
	lossText,
	type MigrationDraft,
	type MigrationFolder,
	planMigration,
	type PlannedDraft,
	type ProgramFootprints,
	renderMigration,
	type SeekTargets,
	type ServedWorkloadPlan,
	servedPrograms,
	servedWorkload,
	servedWorkloadExtension,
	withProgramAccess,
	type Spellings,
	writeRuntimeSnapshot,
	writeSnapshot
} from "#compiler/plan/migration.ts"
import {
	type DeploySnapshot,
	derivedHolds,
	installationsOf,
	installBasis,
	isEmptySnapshot,
	noWorkload,
	recordHolds,
	rosterFates,
	snapshotFileName,
	type SnapshotFiles,
	spellingsOf,
	type InstallBasis
} from "#compiler/plan/serve.ts"

interface GenerateOptions {
	readonly mode: GenerateMode
	/** A declared schema name or PostgreSQL schema identifier of the configuration, or none for every schema. */
	readonly schema: Option.Option<string>
	/** The draft's declared renames and drops (renames.ts), each the one chosen schema's. */
	readonly declared: Declarations
	/** What the run's phases are reported to (`--phases`), or silentPhases. */
	readonly phases: Phases
}

interface DraftMarker {
	readonly file: string
	readonly kind: ReturnType<typeof findMarkers>[number]["kind"]
	readonly line: number
}

/** A loss of stored data a drafted folder leaves to the reviewer: its file, and what it loses (render/folder.ts lossText). */
interface DraftLoss {
	readonly file: string
	readonly loses: string
}

/**
 * What generate wrote for one schema's snapshot: nothing; the snapshot files written again for their derived facts
 * alone, with no folder; an empty custom folder, its name and path; or a drafted folder and the snapshot files it
 * replaced, manifest.json's path and snapshot.json's.
 */
type Written =
	| { readonly kind: "unchanged" }
	| { readonly kind: "rederived"; readonly snapshotPaths: ReadonlyArray<string> }
	| { readonly kind: "custom"; readonly folder: string; readonly path: string }
	| {
			readonly kind: "drafted"
			readonly folder: string
			readonly path: string
			readonly snapshotPaths: ReadonlyArray<string>
	  }

/**
 * `grizzle generate` and `grizzle generate --custom`.
 *
 * For each configured schema (or the one `--schema` names), the command reads the committed snapshot and folders
 * (committed.ts), compiles the schema with every installer extension a deployment needs, its derived relations, its logins' workloads' access paths and statistics and its logins' worlds, and hands the
 * installation, the previous snapshot, each workload program's access and the access requests, the name and the
 * timestamp to the pure generator (compiler/deploy/render/generate.ts). The generator diffs the snapshots and renders
 * the phased files and meta.json; this command supplies the timestamp, the committed chain's next (timestamp.ts), and
 * writes the result (files.ts):
 *
 * - a schema whose target equals its previous snapshot drafts nothing and keeps its snapshot's files, unless the derived
 *   runtime facts snapshot.json records are not the ones the compile derives, or it records none (build.ts
 *   derivedHolds), or manifest.json's record is not the compile's (build.ts recordHolds): then both files are written
 *   again from the compile's snapshot, with no folder, since neither the facts nor the record's layout of the content
 *   is part of the fingerprinted content;
 * - otherwise the folder `<migrations>/<schema>/<timestamp>_<name>/` is written whole, then manifest.json and
 *   snapshot.json are replaced by the new snapshot's. A folder may hold no SQL file when only the snapshot changed, such as a workload program whose
 *   access moved onto an index that already exists. Its name is `--name`, else derived from the change (compiler/deploy/render/naming.ts).
 *
 * A custom migration is the empty folder whose source and target are both the committed snapshot, for hand-written
 * data steps, named `--name`; the snapshot's files do not change.
 *
 * Beside the snapshot, every other draft brings the schema's served and openapi directories to the snapshot it commits:
 * each login of the configuration over the schema has its workload compiled under that snapshot (eachServedFile), and its
 * `served/<login>.json` and its OpenAPI document `openapi/<login>.json`, read off that served file, are written where
 * the directory does not hold that text, and the files of a login the configuration no longer lists are removed. A
 * custom folder changes no snapshot and compiles nothing, so it leaves them.
 *
 * Every selected schema drafts before anything is put in place, each file staged as its text is made and held no longer
 * (files.ts Staging), so a schema the compiler refuses leaves no file of any schema in place, and the heap holds a
 * schema's compile and one file's text at a time, never every file's; a name the previous snapshot holds that the schema
 * no longer does is refused unless the command line
 * declares it renamed or dropped (`--rename`, `--drop`). The report lists each written file, each marker a reviewer
 * must resolve (a placeholder to fill, a group of statements to confirm), and each loss of stored data a reviewer must
 * decide, before `grizzle check` and `grizzle migrate` accept the folder. A schema's first draft beside the migrations of schemas the configuration no longer lists, which a schema
 * renamed in code leaves, starts the schema under the loss of their rows (abandonedSchemas). generate never reads the
 * configuration's connection.
 */
export type SchemaGenerateReport = SchemaWritten & {
	readonly schema: string
	readonly ident: string
	/** The snapshot the schema's directory now commits. */
	readonly fingerprint: string
	/** The path of each served file and OpenAPI document written, its text not the one the directory held. */
	readonly served: ReadonlyArray<string>
	/** The path of each served file and OpenAPI document removed, of a login the configuration no longer lists. */
	readonly unserved: ReadonlyArray<string>
	/** The certificate of every role of the schema's logins, its reasons with it (ServedBasis); none for a custom folder. */
	readonly certification: ServedWorkloadPlan["certification"]
	/** The relations each login fences, with the roles that rely on each (ServedBasis); none for a custom folder. */
	readonly fences: ServedWorkloadPlan["fences"]
}

/** What writing a draft's folder and snapshot wrote (Written), with the folder's files, markers and losses. */
type SchemaWritten = Written & {
	/** The folder's SQL files, by name; none when nothing was written. */
	readonly files: ReadonlyArray<string>
	readonly markers: ReadonlyArray<DraftMarker>
	/** Each loss of stored data the folder drafts, by file, with what it loses. */
	readonly losses: ReadonlyArray<DraftLoss>
	/** The most locks one transaction of each drafted file holds, as its meta.json records it (deploy/locks/demand.ts). */
	readonly locks: ReadonlyArray<{ readonly file: string; readonly locks: number }>
}

/** The refusal of `step` of a schema's draft, which the compiler refused. */
const draftRefused =
	(schema: string, step: DraftRefused["step"]) =>
	(error: CompileError): CliError =>
		cliError(new DraftRefused({ schema, step, error }))

/** The refusal of the schema choice a command line makes, for `fault`. */
const refuseChoice = (fault: SchemaChoiceRefused["fault"]): Result.Result<never, CliError> =>
	Result.fail(cliError(new SchemaChoiceRefused({ fault })))

/** The configured schemas the command applies to. */
const selectSchemas = (
	config: ResolvedConfig,
	options: Pick<GenerateOptions, "schema" | "mode" | "declared">
): Result.Result<ReadonlyArray<ConfiguredSchema>, CliError> => {
	const schemas = Arr.map(config.schemas, (s) => ({ declared: s.declared, ident: s.ident }))
	if (Option.isSome(options.schema)) {
		const named = options.schema.value
		if (config.schemas.length === 1) {
			return refuseChoice({ kind: "single" })
		}
		const found = Arr.filter(config.schemas, (s) => s.declared === named || s.ident === named)
		if (found.length === 0) {
			return refuseChoice({ kind: "unknown", named, schemas })
		}
		return Result.succeed(found)
	}
	if (config.schemas.length > 1) {
		if (options.mode.kind === "custom") {
			return refuseChoice({ kind: "unchosen", by: "custom", schemas })
		}
		if (options.declared.renames.length > 0 || options.declared.drops.length > 0) {
			return refuseChoice({ kind: "unchosen", by: "declarations", schemas })
		}
	}
	return Result.succeed(config.schemas)
}

/**
 * What a draft does to a schema's directory of one kind of login file: the file of each login, by its declared name,
 * whose text the directory does not hold, staged (files.ts stageLoginFile), and the file of each login the
 * configuration no longer lists over the schema, removed.
 */
interface LoginWrites {
	readonly write: ReadonlyArray<string>
	readonly remove: ReadonlyArray<string>
}

/** What a draft does to a schema's directories of login files, by kind (files.ts loginFiles). */
type ServedWrites = { readonly [K in LoginFileKind]: LoginWrites }

/** A custom folder leaves the login files as they are. */
const noServedWrites: ServedWrites = {
	served: { write: [], remove: [] },
	openapi: { write: [], remove: [] }
}

/**
 * A folder a draft staged (files.ts stageFolder): its name, its SQL files' names, each marker its files hold, and each
 * loss and each file's locks its meta.json records, which the report states once the folder is put in place; its texts
 * are written, and held no longer.
 */
interface StagedFolder {
	readonly name: string
	readonly files: ReadonlyArray<string>
	readonly markers: ReadonlyArray<DraftMarker>
	readonly losses: ReadonlyArray<DraftLoss>
	readonly locks: ReadonlyArray<{ readonly file: string; readonly locks: number }>
}

/**
 * A schema's draft, every file of it staged as its text was made (files.ts Staging): nothing to write; snapshot.json
 * and manifest.json staged again, its derived facts the compile's, with no folder, manifest.json by the entries it is
 * laid out in; an empty custom folder; or a drafted folder and its new snapshot's files. Beside any of them but the
 * custom folder, the login files of the snapshot the schema's directory commits once the draft is put in place
 * (commitDraft). It holds no text: a draft is held until every selected schema has drafted, and its texts are on disk.
 */
export type StagedDraft = (
	| { readonly kind: "unchanged" }
	| { readonly kind: "rederived"; readonly manifest: ReadonlyArray<string> }
	| { readonly kind: "custom"; readonly folder: StagedFolder }
	| {
			readonly kind: "drafted"
			readonly folder: StagedFolder
			readonly manifest: ReadonlyArray<string>
	  }
) & {
	readonly schema: ConfiguredSchema
	readonly staging: Staging
	/** The fingerprint of the snapshot the schema's directory commits once the draft is put in place. */
	readonly fingerprint: string
	readonly served: ServedWrites
	/** The certificate of every role of the schema's logins, which the served files record the levels of. */
	readonly certification: ServedWorkloadPlan["certification"]
	/** The relations each login fences, which the served writes lock and the installation grants MAINTAIN on. */
	readonly fences: ServedWorkloadPlan["fences"]
}

/**
 * What one login's served file compiles over: its base's artifacts, compiled under the draft's codes over every
 * relation; each of its roles with its ChangeSets compiled over them by the draft's workload plan
 * (program/workload/compile.ts servedWorkload) at the level its certificate gives its writes, by the role's name in the
 * login; and the footprint of every query program of its workloads, by name, the plan's (WorkloadFootprints).
 */
export interface PlannedLogin {
	readonly artifacts: InstalledArtifacts
	readonly roles: ReadonlyMap<string, ServableRole<Isolation, InstalledSource>>
	readonly footprints: ProgramFootprints
}

/**
 * What every login of a schema's served file compiles over, by its declared name (PlannedLogin, draftInput), and the
 * certificate of every role of every login, its reasons with it, which the plan certified each level from; none for a
 * schema with no login, which compiles no served file.
 */
export type ServedBasis =
	| { readonly kind: "noLogin" }
	| ({
			readonly kind: "logins"
			/**
			 * The stored tables of the installation drafted beside the served files, with the indexes it plans on them,
			 * and the views its roles read through, which every read and write a served file sends is held to
			 * (adapter/served/compile.ts servedEntry).
			 */
			readonly seeks: SeekTargets
	  } & ServedLogins)

/** Each login's plan, with the certification and the fences of the logins' workloads: planned before the installation. */
interface ServedLogins {
	readonly logins: ReadonlyMap<string, PlannedLogin>
	readonly certification: ServedWorkloadPlan["certification"]
	readonly fences: ServedWorkloadPlan["fences"]
}

/** The closed imports of a login's programs (engine schema/reach.ts servedImportsOf), with the content of the level its
 * base is, which every login over the same level's artifacts admit. */
interface ServedLevel {
	readonly content: SchemaContent
	readonly served: ReadonlySet<QueryDesc>
}

/**
 * The logins' workloads and their roles' write filters, planned under the configured schema's artifacts and the names
 * the installation drafted gives it, so the index requests name its vector schema (program/workload/compile.ts
 * planWorkload), then each login's ChangeSets compiled once over the artifacts its served file compiles over
 * (servedWorkload), each over the front end the plan compiled of it where that is the one its compile builds, the
 * variant of a ChangeSet over a role in which every fill context holds a fact, over the plan's basis, with the
 * transaction's clock (program/workload/planned.ts PlannedFrontends), so its front end is compiled once: the configured
 * schema's for a login over its level, and for a login over a level below, that
 * level's, compiled from the basis's derived facts as a snapshot records them (deploy/snapshot/build.ts derivedFacts,
 * adapter/served/login.ts artifactsUnder), under the draft's codes `codes`, each casting the programs' parameters to
 * the types the workload's plan declares (WorkloadPhysical.params), its programs' and those each login states beside
 * them (adapter/served/login.ts LoginInput `stated`), which the installation drafted installs and its snapshot records. The plan, with what each login's served file compiles over (ServedBasis): each role's change
 * members servable (program/workload/change.ts servableRole), its certification having read their compiled writes, and
 * the plan without them, so no compiled write's front end, analysis, schedule or placement, nor the plan's front ends,
 * outlives this compile into the installation's (installationUnder), where they were every compiled write's whole
 * until the served files were projected. Every login's roles are named under its artifacts' installation before any login compiles
 * (physical/ddl/names.ts namedLogin), so a role whose PostgreSQL role does not fit is DraftRefused with
 * IdentifierTooLong; a program the checker refuses is DraftRefused, and a login's ChangeSet that does not compile
 * ServedRefused. The workload's plan and the change compile are phases reported to `phases` (`workload`, `changes`).
 */
const plannedLogins = Effect.fn("plannedLogins")(function* (
	schema: CompiledSchema,
	basis: InstallBasis,
	served: ReadonlyArray<ServedLevel>,
	codes: Codebook,
	phases: Phases
) {
	const { logins } = schema
	const refusedAt = (step: DraftRefused["step"]) => draftRefused(schema.declared, step)
	const configuredArtifacts = yield* Effect.mapError(
		fromEngine(artifactsOver(basis, unserved)),
		refusedAt("workload")
	)
	const options = {
		artifacts: configuredArtifacts,
		roles: Arr.flatMap(logins, (l) => l.owned.roles)
	}
	const { plan: programs, frontends } = yield* Effect.mapError(
		fromEngine(
			phased(phases, { name: "workload", of: [] }, () =>
				planWorkload(
					Arr.map(logins, (l) => ({ login: l.owned.name, workloads: l.login.workload })),
					schema.schema,
					options,
					phases
				)
			)
		),
		(refused) => refusedAt("workload")(refused.error)
	)
	/** The plan's parameter types its programs', and each login's stated beside them (LoginInput `stated`). */
	const workload = {
		...programs,
		params: servedTogether([programs.params, ...Arr.map(logins, (l) => l.login.stated)])
	}
	const derived = derivedFacts(basis.closed, basis.model, basis.textDomains, basis.library)
	const params: InstalledSource = { kind: "planned", types: workload.params }
	const servedArtifacts = yield* Effect.mapError(
		fromEngine(artifactsOver(basis, params)),
		refusedAt("workload")
	)
	/**
	 * The artifacts of each distinct level below the configured schema's a login stands on, built once from the first
	 * such login's owned base and read by every login over the same level (sameLevel, the levels' content, never their
	 * objects), where each login built its own, its law model and law-violation DAG among them, though logins share
	 * levels (metis's measure-full at changes start: 21 logins' artifacts, 40 to 63 MB each, 807 MB, none shared). Each
	 * reads every relation within the installation (engine analysis/schema.ts RealityReading `within`): the installation's
	 * checked schema's info, holding, canonical relation, definition and analysis of it, by reference, where each level
	 * analyzed its whole chain again (metis at PIN 2: nine levels, about 60 MB of analysis each, the shared base's).
	 */
	const below: Array<{
		readonly content: SchemaContent
		readonly artifacts: InstalledArtifacts
	}> = []
	const artifactsOf = (l: (typeof logins)[number]): Effect.Effect<InstalledArtifacts, CliError> => {
		if (sameLevel(l.login.base.content, schema.schema.content)) {
			return Effect.succeed(servedArtifacts)
		}
		const known = Arr.findFirst(below, (b) => sameLevel(b.content, l.login.base.content))
		return Option.isSome(known)
			? Effect.succeed(known.value.artifacts)
			: Effect.mapBoth(
					fromEngine(
						artifactsUnder(
							l.owned.base,
							codes,
							derived,
							params,
							{ kind: "within", installation: servedArtifacts.derived.schema },
							new Set(
								Arr.flatMap(served, (level) =>
									sameLevel(level.content, l.login.base.content) ? [...level.served] : []
								)
							)
						)
					),
					{
						onFailure: refusedAt("workload"),
						onSuccess: (artifacts) => {
							below.push({ content: l.login.base.content, artifacts })
							return artifacts
						}
					}
				)
	}
	const loginsNamed = yield* Effect.forEach(logins, (l) =>
		Effect.flatMap(artifactsOf(l), (artifacts) =>
			Effect.mapBoth(fromEngine(namedLogin(l.owned, artifacts.names.levels)), {
				onFailure: refusedAt("workload"),
				onSuccess: (named) => ({ login: l, named, artifacts })
			})
		)
	)
	const plan = yield* Effect.mapError(
		fromEngine(
			phased(phases, { name: "changes", of: [] }, () =>
				servedWorkload(
					workload,
					Arr.map(loginsNamed, ({ login: l, named, artifacts }) => ({
						name: l.owned.name,
						roles: l.login.roles,
						workload: l.login.workload,
						named,
						artifacts,
						clock: transactionClock,
						planned: frontends
					})),
					options,
					phases
				)
			)
		),
		(refused) =>
			refused.kind === "workload"
				? refusedAt("workload")(refused.error)
				: cliError(
						new ServedRefused({
							schema: schema.declared,
							login: refused.login,
							...atRole(refused.refused)
						})
					)
	)
	const basisOf: ServedLogins = {
		certification: plan.certification,
		fences: plan.fences,
		logins: new Map(
			Arr.map(loginsNamed, ({ login: l, artifacts }) => {
				const roles = plan.changes.get(l.owned.name)
				const footprints = plan.footprints.get(l.owned.name)
				if (roles === undefined || footprints === undefined) {
					defect(`the change compile of login ${l.owned.name}, a login of the plan`)
				}
				return [
					l.owned.name,
					{
						artifacts,
						roles,
						footprints
					}
				] as const
			})
		)
	}
	const { changes: _certified, ...installed } = plan
	return { plan: { ...installed, programs: servedPrograms(plan.changes) }, served: basisOf }
})

/**
 * The history a schema's draft from `previous` drafts its codes from (CodesFrom), under `declared`: each roster the
 * snapshot holds, under the name of the roster it continues as (deploy/snapshot/build.ts rosterFates), the declared
 * handle renames (cli/renames.ts rosterRenames), and the spellings `previous` records of its pattern languages
 * (spellingsOf), each language's history as a roster's codes are: a roster's codes are its history, so a handle keeps
 * its code, a renamed one its old one's, a removed one leaves a hole and a new one takes the next.
 */
const codesFrom = (
	schema: CompiledSchema,
	previous: DeploySnapshot,
	declared: Declarations
): Result.Result<CodesFrom, CliError> => {
	const rosters = rostersOf(schema.owned)
	return Result.mapBoth(rosterRenames(declared, rosters), {
		onFailure: cliError,
		onSuccess: (renames): CodesFrom => ({
			previous: rosterFates(
				previous,
				declared,
				Arr.map(rosters, (r) => r.closed)
			),
			renames,
			spellings: spellingsOf(previous)
		})
	})
}

/**
 * What the draft of a schema's change from `previous` is drafted from: its schema compiled with every installer
 * extension a deployment needs and its logins' workloads' access paths, with the schemas it abandons (abandonedSchemas)
 * and the renames and drops `declared` declares. Everything is compiled under the codes the draft gives the schema's
 * rosters, drafted from `history` (CodesFrom: the codes `previous` records, codesFrom, wherever generate drafts), and
 * an ordered roster declared out of its codes' order is RosterReordered (installationUnder).
 */
const draftInput = Effect.fn("draftInput")(function* (
	schema: CompiledSchema,
	previous: DeploySnapshot,
	history: CodesFrom,
	abandoned: ReadonlyArray<AbandonedSchema>,
	declared: Declarations,
	phases: Phases
): Effect.fn.Return<{ readonly input: DraftInput; readonly served: ServedBasis }, CliError> {
	const compiled = yield* installationUnder(schema, history, phases)
	return {
		input: {
			previous,
			installation: compiled.installation,
			workload: compiled.workload,
			abandoned,
			declared
		},
		served: compiled.served
	}
})

/**
 * The history a schema's codes are drafted from (ir/codes.ts draftCodebook): each roster the previous installation
 * holds with what the draft makes of it, the declared handle renames, and the spelling the history holds of each
 * pattern language: the committed snapshot's.
 */
export interface CodesFrom {
	readonly previous: ReadonlyArray<PreviousRoster>
	readonly renames: RosterRenames
	readonly spellings: Spellings
}

/**
 * A schema compiled under the codes drafted from `history` (CodesFrom): its installation with every installer extension
 * a deployment needs, its logins' workloads' access, and what each login's served file compiles over. An ordered roster
 * declared out of its codes' order is RosterReordered. The schema's basis is compiled once: the artifacts the workloads'
 * access paths are planned against and the installation the draft installs share one law model and one plan of the
 * closed constants (physical/install/plan.ts installBasis). Each login's ChangeSets are compiled once in the workload
 * plan (plannedLogins), and its other programs once the draft lays out its snapshot (eachServedFile). The basis, the
 * logins' plan and the installation are phases reported to `phases` (`basis`, `installation`).
 */
export const installationUnder = Effect.fn("installationUnder")(function* (
	schema: CompiledSchema,
	history: CodesFrom,
	phases: Phases
): Effect.fn.Return<
	{
		readonly installation: Installation
		readonly workload: DraftInput["workload"]
		readonly served: ServedBasis
	},
	CliError
> {
	const { owned, logins } = schema
	const rosters = rostersOf(owned)
	const drafted = draftCodebook(history.previous, history.renames, rosters, history.spellings)
	if (!drafted.ok) {
		const { roster, earlier, later } = drafted.error
		return yield* cliError(new RosterReordered({ schema: schema.declared, roster, earlier, later }))
	}
	const codes = drafted.value
	const refusedAt = (step: DraftRefused["step"]) => draftRefused(schema.declared, step)
	/** The closed imports of each login's programs, with the level its base is (engine schema/reach.ts
	 * servedImportsOf), which the installation stores where admission stores them. */
	const served = yield* Effect.forEach(logins, (l) =>
		Effect.mapBoth(workloadReach(l.login, l.owned), {
			onFailure: (refused) => refusedAt("workload")(refused.error),
			onSuccess: (reach): ServedLevel => ({ content: l.login.base.content, served: reach.served })
		})
	)
	const basis = yield* Effect.mapError(
		fromEngine(
			phased(phases, { name: "basis", of: [] }, () =>
				installBasis(owned, codes, new Set(Arr.flatMap(served, (level) => [...level.served])))
			)
		),
		refusedAt("schema")
	)
	/** The unrepresentable keys the schema's compile met so far, which a refusal of its logins' workloads, met after
	 * them, gives way to (engine core/canonical.ts metFirst). */
	const unrepresentable = basis.model.unrepresentable
	const planned = Arr.isReadonlyArrayNonEmpty(logins)
		? yield* Effect.catch(plannedLogins(schema, basis, served, codes, phases), (refused) =>
				Arr.isReadonlyArrayNonEmpty(unrepresentable)
					? Effect.fail(refusedAt("schema")(unrepresentableKeys(unrepresentable)))
					: Effect.fail(refused)
			)
		: undefined
	const options = completeInstallOptions(
		owned,
		installationsOf(owned),
		Arr.map(logins, (l) => l.owned),
		planned === undefined ? [] : [servedWorkloadExtension(planned.plan)],
		codes
	)
	const installation = yield* Effect.mapError(
		fromEngine(
			phased(phases, { name: "installation", of: [] }, () =>
				installationOver(basis, options, phases)
			)
		),
		refusedAt("schema")
	)
	return {
		installation,
		workload:
			planned === undefined
				? noWorkload
				: ((indexed) => ({
						access: indexed.access,
						accessPaths: indexed.requests,
						live: indexed.live
					}))(
						withProgramAccess(
							planned.plan,
							installation.programAccess,
							installation.names.vectorSchema
						)
					),
		served:
			planned === undefined
				? { kind: "noLogin" }
				: { kind: "logins", seeks: installation.seeks, ...planned.served }
	}
})

/**
 * The draft of a schema's change from `previous` under `declared`, its folder unnamed, as `grizzle check` compares it
 * with the committed snapshot (draftSchemaUnder, its codes drafted from those `previous` records, codesFrom), beside the
 * installation it drafts against, whose constants check holds the migrations' literal packs to. Nothing is written.
 */
export const draftSchema = Effect.fn("draftSchema")(function* (
	schema: CompiledSchema,
	previous: DeploySnapshot,
	abandoned: ReadonlyArray<AbandonedSchema>,
	declared: Declarations,
	phases: Phases
): Effect.fn.Return<
	MigrationDraft & { readonly installation: Installation; readonly served: ServedBasis },
	CliError
> {
	const history = yield* Effect.fromResult(codesFrom(schema, previous, declared))
	return yield* draftSchemaUnder(schema, previous, history, abandoned, declared, phases)
})

/**
 * The draft of a schema's change from `previous` under `declared`, its folder unnamed, its codes drafted from `history`
 * (draftInput, then the pure generator's draftMigration), beside the installation it drafts against: draftSchema's, and
 * a test's draft of an installation whose codes its case states, holes included, which no snapshot before it records
 * (ir/codes.ts keptRosters). Nothing is written.
 */
export const draftSchemaUnder = Effect.fn("draftSchemaUnder")(function* (
	schema: CompiledSchema,
	previous: DeploySnapshot,
	history: CodesFrom,
	abandoned: ReadonlyArray<AbandonedSchema>,
	declared: Declarations,
	phases: Phases
): Effect.fn.Return<
	MigrationDraft & { readonly installation: Installation; readonly served: ServedBasis },
	CliError
> {
	const { input, served } = yield* draftInput(
		schema,
		previous,
		history,
		abandoned,
		declared,
		phases
	)
	const draft = yield* Effect.mapError(
		fromEngine(phased(phases, { name: "draft", of: [] }, () => draftMigration(input))),
		draftRefused(schema.declared, "draft")
	)
	return { ...draft, installation: input.installation, served }
})

/**
 * A schema's draft as check keeps it past the draft phase (`keptOf`), beside its installation and served basis: what
 * `draftSchema` drafts, its plan and decision record left behind, so check's served files compile without them.
 */
export const keptSchemaDraft = (
	...args: Parameters<typeof draftSchema>
): Effect.Effect<
	Drafted & { readonly installation: Installation; readonly served: ServedBasis },
	CliError
> =>
	Effect.map(draftSchema(...args), (draft) => ({
		...keptOf(draft),
		installation: draft.installation,
		served: draft.served
	}))

/**
 * What check keeps of a draft past the draft phase: what it changes, its folder, its snapshot and the derived facts
 * snapshot.json records, which the served files and check's findings read. The draft's plan (every step's statement as
 * its tree) and its decision record (every statement's tokens) are the draft's own, which nothing after it reads, so they
 * are left behind at the draft's end rather than held through the served files' compile (edullm's qti App at hub
 * 5374a0575: the plan alone 217 MB of the 2.2 GB live as the served phase starts).
 */
type Drafted = Pick<MigrationDraft, "change" | "folder" | "snapshot" | "derived">

/** A draft as check keeps it (`Drafted`). */
export const keptOf = (draft: MigrationDraft): Drafted => ({
	change: draft.change,
	folder: draft.folder,
	snapshot: draft.snapshot,
	derived: draft.derived
})

/**
 * A schema's change from `previous` planned as `grizzle generate` drafts it, its codes drafted from those `previous`
 * records (codesFrom, draftInput, then the pure generator's planMigration, the `draft` phase), with what its logins'
 * served files compile over: the installation is left behind at the plan's end, and nothing is written.
 */
const plannedSchema = Effect.fn("plannedSchema")(function* (
	schema: CompiledSchema,
	previous: DeploySnapshot,
	abandoned: ReadonlyArray<AbandonedSchema>,
	declared: Declarations,
	phases: Phases
): Effect.fn.Return<PlannedSchema, CliError> {
	const history = yield* Effect.fromResult(codesFrom(schema, previous, declared))
	const { input, served } = yield* draftInput(
		schema,
		previous,
		history,
		abandoned,
		declared,
		phases
	)
	const planned = yield* Effect.mapError(
		fromEngine(phased(phases, { name: "draft", of: [] }, () => planMigration(input))),
		draftRefused(schema.declared, "draft")
	)
	return { planned, served }
})

/** A schema's draft planned (PlannedDraft), with what its logins' served files compile over (ServedBasis). */
export interface PlannedSchema {
	readonly planned: PlannedDraft
	readonly served: ServedBasis
}

/** What a draft's snapshot files are written from: its snapshot and the derived runtime facts snapshot.json records. */
type DraftSnapshot = Pick<MigrationDraft, "snapshot" | "derived">

/** The texts of a draft's snapshot files, which generate writes. */
export const snapshotFilesOf = (
	schema: CompiledSchema,
	draft: DraftSnapshot
): Effect.Effect<SnapshotFiles, CliError> =>
	Effect.mapError(
		fromEngine(writeSnapshot(draft.snapshot, draft.derived)),
		draftRefused(schema.declared, "draft")
	)

/**
 * Stages a draft's snapshot files (snapshotFilesOf, files.ts stageSnapshotFiles), refused where snapshot.json, which an
 * application imports whole, is past generatedFileMaxBytes (files.ts unsplitWithin), manifest.json laid out in parts
 * within it; returns the entries manifest.json is laid out in. Their texts are written, and held no longer.
 */
export const stagedSnapshotFiles = Effect.fn("stagedSnapshotFiles")(function* (
	compiled: CompiledSchema,
	staging: Staging,
	draft: DraftSnapshot
): Effect.fn.Return<ReadonlyArray<string>, CliError, FileSystem.FileSystem | Path.Path> {
	const files = yield* snapshotFilesOf(compiled, draft)
	yield* unsplitWithin(
		compiled.declared,
		[{ file: snapshotFileName, text: files.snapshot }],
		generatedFileMaxBytes
	)
	return yield* stageSnapshotFiles(compiled.declared, staging, files, generatedFileMaxBytes)
})

/**
 * Stages `folder` (files.ts stageFolder) and reads what the report states of it (StagedFolder): its SQL files' names,
 * each marker they hold, and the losses and locks its meta.json records.
 */
const stagedFolder = Effect.fn("stagedFolder")(function* (
	schema: ConfiguredSchema,
	staging: Staging,
	folder: MigrationFolder
): Effect.fn.Return<StagedFolder, CliError, FileSystem.FileSystem | Path.Path> {
	yield* stageFolder(schema.declared, staging, folder, generatedFileMaxBytes)
	const staged: StagedFolder = {
		name: folder.name,
		files: Arr.map(folder.files, (f) => f.name),
		markers: Arr.flatMap(folder.files, (f) =>
			Arr.map(findMarkers(new ChunkView(f.text)), (m) => ({
				file: f.name,
				kind: m.kind,
				line: m.line
			}))
		),
		losses:
			folder.meta.kind === "drafted"
				? Arr.flatMap(folder.meta.files, (f) =>
						Arr.flatMap(f.steps, (s) =>
							s.kind === "loss" ? [{ file: f.name, loses: lossText(s.loses) }] : []
						)
					)
				: [],
		locks:
			folder.meta.kind === "drafted"
				? Arr.map(folder.meta.files, (f) => ({ file: f.name, locks: f.locks }))
				: []
	}
	return staged
})

/**
 * A schema's draft as generate holds it once staged (stagedOver), but for its snapshot's files: its snapshot and derived
 * facts, what it changes, with the folder it staged where it changes the schema (stagedFolder), its login files' writes,
 * and its logins' certificates and fences. It holds no text, no plan and nothing the served files compiled over.
 */
interface DraftStaged extends DraftSnapshot {
	readonly drafted:
		| { readonly kind: "none" }
		| { readonly kind: "schema"; readonly folder: StagedFolder }
	readonly served: ServedWrites
	readonly certification: ServedWorkloadPlan["certification"]
	readonly fences: ServedWorkloadPlan["fences"]
}

/**
 * A planned draft's folder rendered and named by `naming` and `timestamp` (the pure generator's renderMigration, the
 * `render` phase) and staged (stagedFolder), its texts and its decision record dropped once written; none where the
 * draft changes nothing, whose folder generate writes no file of.
 */
const renderedFolder = Effect.fn("renderedFolder")(function* (
	schema: ConfiguredSchema,
	staging: Staging,
	planned: PlannedDraft,
	naming: FolderNaming,
	timestamp: string,
	phases: Phases
): Effect.fn.Return<DraftStaged["drafted"], CliError, FileSystem.FileSystem | Path.Path> {
	if (planned.change === "none") {
		return { kind: "none" }
	}
	const folder = yield* Effect.flatMap(
		Effect.mapError(
			fromEngine(
				phased(phases, { name: "render", of: [] }, () =>
					renderMigration(planned, naming, timestamp)
				)
			),
			draftRefused(schema.declared, "draft")
		),
		(rendered) => stagedFolder(schema, staging, rendered.folder)
	)
	return { kind: "schema", folder }
})

/**
 * A planned schema staged, each product made where its inputs first stand and dropped there: the served files compiled
 * under the plan's snapshot and staged as each compiles (stagedServed), what they compile over (ServedBasis: each
 * level's artifacts and each login's ChangeSets) held no longer than the last of them; then the folder rendered and
 * staged (renderedFolder), the plan held no longer than it. A login's served file reads of the draft its snapshot alone,
 * and of the snapshot's facts the plan decides its fingerprint alone (engine render/generate.ts PlannedDraft), so the
 * served files need the plan's snapshot and not its folder, and the folder needs nothing they compile over: the
 * rendering's own transient (every statement printed, every file's text, the decision record) never stands beside what
 * the served files compile over, where the draft rendered the folder beside both (metis's installation at grizzle
 * dfc9f60e: the served files' 515 MB of level artifacts and 70 MB of ChangeSets held through its whole draft).
 */
export const stagedOver =
	(
		configured: ConfiguredSchema,
		compiled: CompiledSchema,
		staging: Staging,
		committed: LoginPaths,
		naming: FolderNaming,
		timestamp: string,
		phases: Phases
	) =>
	(
		schema: PlannedSchema
	): Effect.Effect<DraftStaged, CliError, FileSystem.FileSystem | Path.Path> => {
		const { planned, served } = schema
		const certification = served.kind === "logins" ? served.certification : []
		const fences = served.kind === "logins" ? served.fences : []
		return Effect.zipWith(
			stagedServed(configured, compiled, planned, served, staging, committed, phases),
			renderedFolder(configured, staging, planned, naming, timestamp, phases),
			(writes, drafted): DraftStaged => ({
				snapshot: planned.snapshot,
				derived: planned.derived,
				drafted,
				served: writes,
				certification,
				fences
			})
		)
	}

/**
 * The JSON value of the snapshot.json text a draft lays out (writeRuntimeSnapshot), as an application's import of the
 * file yields it: what every login's served file compiles under. The text is held no longer than its read.
 */
const runtimeSnapshotValue = (
	schema: CompiledSchema,
	draft: DraftSnapshot
): Effect.Effect<unknown, CliError> =>
	Effect.mapBoth(fromEngine(writeRuntimeSnapshot(draft.snapshot, draft.derived)), {
		onFailure: draftRefused(schema.declared, "draft"),
		onSuccess: (text) => {
			const read = readJson(text)
			if (!read.ok) {
				defect(`the snapshot.json a draft lays out reads as JSON: ${read.error.expected}`)
			}
			return read.value
		}
	})

/**
 * Each login's served file, in configured order, handed to `sink` as it is compiled: its workload compiled under the
 * snapshot.json text the draft lays out, the draft's (adapter/served/compile.ts servedEntry), over the artifacts
 * `served` holds for it, its ChangeSets as the draft's workload plan compiled them (PlannedLogin): a login over the
 * schema's own level over the installation's artifacts, and one over a level below, whose ownership is its own
 * (cli/config.ts compileSchema), over that level's, as the snapshot records them. generate stages them beside the
 * snapshot and check holds the committed ones to them, so both compile every login once, from the one text. A login
 * whose workload does not compile is ServedRefused, at the login, its role or its program. The served files are a phase
 * reported to `phases` (`served`), each login's compile a phase inside it (`servedLogin`).
 *
 * Only what `sink` returns is kept: a login's texts are the sink's to write or to compare, and none outlives its sink,
 * where every login's were held until the last was compiled and then until the write (metis's installation from
 * nothing at grizzle dfc9f60e: its 24 logins' served files and OpenAPI documents, 92 MB of text, held at once).
 */
export const eachServedFile = <A, E, R>(
	schema: CompiledSchema,
	draft: DraftSnapshot,
	served: ServedBasis,
	phases: Phases,
	sink: (entry: ServedEntry) => Effect.Effect<A, E, R>
): Effect.Effect<ReadonlyArray<A>, CliError | E, R> =>
	phasedEffect(
		phases,
		{ name: "served", of: [] },
		servedEntries(schema, draft, served, phases, sink)
	)

/** Each login's served file handed to `sink` (eachServedFile), each login's compile a phase reported to `phases`. */
const servedEntries = Effect.fn("eachServedFile")(function* <A, E, R>(
	schema: CompiledSchema,
	draft: DraftSnapshot,
	served: ServedBasis,
	phases: Phases,
	sink: (entry: ServedEntry) => Effect.Effect<A, E, R>
): Effect.fn.Return<ReadonlyArray<A>, CliError | E, R> {
	if (served.kind === "noLogin") {
		return []
	}
	const snapshot = yield* runtimeSnapshotValue(schema, draft)
	return yield* Effect.forEach(schema.logins, (login) => {
		const planned = served.logins.get(login.owned.name)
		if (planned === undefined) {
			defect(`the plan of login ${login.owned.name}, a login of the configuration`)
		}
		const compiled = Effect.mapError(
			phasedEffect(
				phases,
				{ name: "servedLogin", of: [login.owned.name] },
				servedEntry(
					login,
					snapshot,
					planned.artifacts,
					planned.roles,
					planned.footprints,
					served.seeks
				)
			),
			(refusal) =>
				cliError(
					new ServedRefused({
						schema: schema.declared,
						login: login.login.desc.name,
						place: refusal.place,
						error: refusal.error
					})
				)
		)
		return Effect.flatMap(compiled, sink)
	})
})

/** The text of a login's file of `kind` its compile gives: its served file's, or its OpenAPI document's. */
export const loginText = (entry: ServedEntry, kind: LoginFileKind): TextChunks =>
	kind === "served" ? entry.text : entry.openapi

/** What staging one login's files did (stageServed): the login, and whether its file of each kind was staged. */
interface LoginStaged {
	readonly login: string
	readonly staged: { readonly [K in LoginFileKind]: boolean }
}

/**
 * A sink of the served files (eachServedFile) staging each login's file of each kind (files.ts stageLoginFile) where
 * `committed` holds none of it or the committed one's bytes part from its text, each committed file read a block at a
 * time and held to the text as it is read (adapter/boundary/files.ts matchesFile), never read whole; the login's files,
 * each imported whole by an application, are refused first where one is past generatedFileMaxBytes (files.ts
 * unsplitWithin).
 */
const stageServed =
	(schema: ConfiguredSchema, staging: Staging, committed: LoginPaths) =>
	(entry: ServedEntry): Effect.Effect<LoginStaged, CliError, FileSystem.FileSystem | Path.Path> =>
		Effect.gen(function* () {
			yield* unsplitWithin(
				schema.declared,
				Arr.map(loginFileKinds, (kind) => ({
					file: loginFiles[kind].path(entry.login),
					text: loginText(entry, kind)
				})),
				generatedFileMaxBytes
			)
			const staged = Effect.fn("stagedLoginFile")(function* (kind: LoginFileKind) {
				const text = loginText(entry, kind)
				const path = committed[kind].get(entry.login)
				const parting =
					path === undefined
						? { kind: "absent" as const }
						: yield* Effect.mapError(matchesFile(path, text), (cause) =>
								cliError(
									new TreeUnread({ schema: schema.declared, directory: schema.directory, cause })
								)
							)
				if (parting.kind === "same") {
					return false
				}
				yield* stageLoginFile(schema.declared, kind, staging, entry.login, text)
				return true
			})
			return {
				login: entry.login,
				staged: { served: yield* staged("served"), openapi: yield* staged("openapi") }
			}
		})

/**
 * Each login's served file and OpenAPI document of `served`, compiled under the draft (eachServedFile), staged where the
 * directory holding the committed files `committed` does not hold its text (stageServed), and what that does to the
 * directories, by kind (ServedWrites): the files staged, and the file of each login the configuration no longer lists,
 * removed.
 */
export const stagedServed = Effect.fn("stagedServed")(function* (
	configured: ConfiguredSchema,
	compiled: CompiledSchema,
	draft: DraftSnapshot,
	served: ServedBasis,
	staging: Staging,
	committed: LoginPaths,
	phases: Phases
): Effect.fn.Return<ServedWrites, CliError, FileSystem.FileSystem | Path.Path> {
	const staged = yield* eachServedFile(
		compiled,
		draft,
		served,
		phases,
		stageServed(configured, staging, committed)
	)
	const listed = new Set(Arr.map(staged, (s) => s.login))
	const writes = (kind: LoginFileKind): LoginWrites => ({
		write: Arr.flatMap(staged, (s) => (s.staged[kind] ? [s.login] : [])),
		remove: Arr.filter(Arr.fromIterable(committed[kind].keys()), (login) => !listed.has(login))
	})
	return { served: writes("served"), openapi: writes("openapi") }
})

/**
 * What a schema's draft reads of its directory: what it commits (committed.ts committedSnapshot), the timestamp its
 * next folder takes, the second after its chain's last (timestamp.ts), and the paths of its login files. The committed
 * folders' texts are read to hold the chain to the snapshot and held no longer than that.
 */
const committedState = Effect.fn("committedState")(function* (schema: ConfiguredSchema) {
	const tree = yield* readSchemaTree(schema.declared, schema.directory)
	const committed = yield* committedSnapshot(schema, tree)
	const chain = yield* continuedChain(schema, tree, committed.snapshot)
	return { committed, timestamp: nextTimestamp(chain.timestamps), logins: tree.logins }
})

/**
 * One schema's draft, every file of it staged as it is made in a staging area of the scope's (files.ts stagingArea),
 * made once the schema's directory is read, so a directory the reading refuses is refused as it is (StagedDraft);
 * nothing is put in place.
 */
const draftFor = Effect.fn("draftFor")(function* (
	config: ResolvedConfig,
	schema: ConfiguredSchema,
	options: GenerateOptions
): Effect.fn.Return<StagedDraft, CliError, FileSystem.FileSystem | Path.Path | Scope.Scope> {
	const { committed, timestamp, logins } = yield* committedState(schema)
	const staging = yield* stagingArea(schema.declared, schema.directory, config.migrations)
	const previous = committed.snapshot
	const mode = options.mode
	if (mode.kind === "custom") {
		const folder = yield* Effect.flatMap(
			Effect.mapError(
				fromEngine(customMigration({ snapshot: previous, name: mode.name, timestamp })),
				draftRefused(schema.declared, "custom")
			),
			(made) => stagedFolder(schema, staging, made)
		)
		return {
			schema,
			staging,
			folder,
			fingerprint: previous.fingerprint,
			served: noServedWrites,
			certification: [],
			fences: [],
			kind: "custom"
		} satisfies StagedDraft
	}
	const compiled = yield* Effect.fromResult(
		phased(options.phases, { name: "build", of: [] }, () => compileSchema(schema))
	)
	const generated = yield* Effect.flatMap(
		plannedSchema(
			compiled,
			previous,
			isEmptySnapshot(previous) ? yield* abandonedSchemas(config) : [],
			options.declared,
			options.phases
		),
		stagedOver(schema, compiled, staging, logins, mode.naming, timestamp, options.phases)
	)
	const { served, certification, fences } = generated
	if (generated.drafted.kind === "none") {
		return committed.kind === "files" &&
			(!derivedHolds(committed.derived, generated.derived) ||
				!recordHolds(committed.snapshot, generated.snapshot))
			? ({
					schema,
					staging,
					fingerprint: previous.fingerprint,
					manifest: yield* stagedSnapshotFiles(compiled, staging, generated),
					served,
					certification,
					fences,
					kind: "rederived"
				} satisfies StagedDraft)
			: ({
					schema,
					staging,
					fingerprint: previous.fingerprint,
					served,
					certification,
					fences,
					kind: "unchanged"
				} satisfies StagedDraft)
	}
	return {
		schema,
		staging,
		folder: generated.drafted.folder,
		fingerprint: generated.snapshot.fingerprint,
		manifest: yield* stagedSnapshotFiles(compiled, staging, generated),
		served,
		certification,
		fences,
		kind: "drafted"
	} satisfies StagedDraft
})

/**
 * The schemas a schema's first draft abandons: each visible directory of the migrations directory (files.ts
 * visibleEntries), holding a snapshot.json, of a schema the configuration no longer lists. A schema renamed in code is a new PostgreSQL schema, which the draft
 * creates empty, and the old one is never migrated again; only the reviewer knows which was meant, so the draft starts
 * the schema under the loss of their rows, a decision the reviewer makes (diff/plan.ts Loss).
 */
const abandonedSchemas = Effect.fn("abandonedSchemas")(
	function* (
		config: ResolvedConfig
	): Effect.fn.Return<
		ReadonlyArray<AbandonedSchema>,
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		if (!(yield* fs.exists(config.migrations))) {
			return []
		}
		const configured = new Set(Arr.map(config.schemas, (s) => s.ident))
		const abandoned: Array<AbandonedSchema> = []
		for (const name of yield* visibleEntries(fs, config.migrations)) {
			const directory = path.join(config.migrations, name)
			const candidate = !configured.has(name) && (yield* fs.stat(directory)).type === "Directory"
			if (candidate && (yield* fs.exists(path.join(directory, snapshotFileName)))) {
				abandoned.push({ schema: name, directory: path.relative(config.directory, directory) })
			}
		}
		return abandoned
	},
	(effect, config) =>
		Effect.mapError(effect, (cause) =>
			cliError(new MigrationsUnread({ directory: config.migrations, cause }))
		)
)

/** Puts a staged draft in place: its folder whole, then its snapshot, then its served files and OpenAPI documents. */
export const commitDraft = Effect.fn("commitDraft")(function* (
	draft: StagedDraft
): Effect.fn.Return<SchemaGenerateReport, CliError, FileSystem.FileSystem | Path.Path> {
	const { schema } = draft
	const schemaWritten = yield* commitSchemaDraft(draft)
	const files = yield* Effect.forEach(loginFileKinds, (kind) =>
		commitLoginFiles(
			schema.declared,
			kind,
			draft.staging,
			draft.served[kind].write,
			draft.served[kind].remove
		)
	)
	const written = Arr.flatMap(files, (f) => f.written)
	const removed = Arr.flatMap(files, (f) => f.removed)
	return {
		...schemaWritten,
		schema: schema.declared,
		ident: schema.ident,
		fingerprint: draft.fingerprint,
		served: written,
		unserved: removed,
		certification: draft.certification,
		fences: draft.fences
	}
})

/** Puts a staged draft's folder in place whole, then its snapshot. */
const commitSchemaDraft = Effect.fn("commitSchemaDraft")(function* (
	draft: StagedDraft
): Effect.fn.Return<SchemaWritten, CliError, FileSystem.FileSystem | Path.Path> {
	const { schema } = draft
	if (draft.kind === "unchanged") {
		const unchanged: SchemaWritten = {
			kind: "unchanged",
			files: [],
			markers: [],
			losses: [],
			locks: []
		}
		return unchanged
	}
	if (draft.kind === "rederived") {
		const rederived: SchemaWritten = {
			kind: "rederived",
			snapshotPaths: yield* commitSnapshotFiles(schema.declared, draft.staging, draft.manifest),
			files: [],
			markers: [],
			losses: [],
			locks: []
		}
		return rederived
	}
	const folder = draft.folder
	const written = {
		folder: folder.name,
		path: yield* commitFolder(schema.declared, draft.staging, folder.name),
		files: folder.files,
		markers: folder.markers,
		losses: folder.losses,
		locks: folder.locks
	}
	if (draft.kind === "custom") {
		const custom: SchemaWritten = { ...written, kind: "custom" }
		return custom
	}
	const drafted: SchemaWritten = {
		...written,
		kind: "drafted",
		snapshotPaths: yield* commitSnapshotFiles(schema.declared, draft.staging, draft.manifest)
	}
	return drafted
})

/**
 * Every selected schema drafted, each in a staging area of its own (files.ts stagingArea), each file staged as its text
 * is made, then every draft put in place, schema by schema, once every one has drafted: a schema the compiler refuses
 * leaves no file of any schema in place, and the staging areas are removed as the command ends, whatever it did.
 */
export const generateMigrations = Effect.fn("generate")(function* (
	config: ResolvedConfig,
	options: GenerateOptions
): Effect.fn.Return<
	ReadonlyArray<SchemaGenerateReport>,
	CliError,
	FileSystem.FileSystem | Path.Path
> {
	const schemas = yield* Effect.fromResult(selectSchemas(config, options))
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const drafts: Array<StagedDraft> = []
			for (const s of schemas) {
				const draft = yield* phasedEffect(
					options.phases,
					{ name: "schema", of: [s.declared] },
					draftFor(config, s, options)
				)
				drafts.push(draft)
			}
			const reports: Array<SchemaGenerateReport> = []
			for (const d of drafts) {
				const report = yield* phasedEffect(
					options.phases,
					{ name: "write", of: [d.schema.declared] },
					commitDraft(d)
				)
				reports.push(report)
			}
			return reports
		})
	)
})
