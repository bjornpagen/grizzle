import { ChunkView, readJson, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import {
	Array as Arr,
	type DateTime,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	Result
} from "effect"
import { matchesFile } from "#adapter/boundary/files.ts"
import { fromEngine } from "#adapter/engine.ts"
import { atRole, type ServedEntry, servedEntry } from "#adapter/served/compile.ts"
import { artifactsOver, artifactsUnder } from "#adapter/served/login.ts"
import type { GenerateMode } from "#cli/args.ts"
import { nextTimestamp } from "#cli/clock.ts"
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
	type LoginFileKind,
	loginFileKinds,
	loginFiles,
	type LoginPaths,
	type LoginText,
	readSchemaTree,
	unsplitWithin,
	writeFolder,
	writeLoginFiles,
	writeSnapshotFiles
} from "#cli/files.ts"
import { phasedEffect } from "#cli/phases.ts"
import { rosterRenames } from "#cli/renames.ts"
import type { ServableRole } from "#compiler/plan/change.ts"
import {
	type Codebook,
	type CompileError,
	defect,
	draftCodebook,
	type PreviousRoster,
	type RosterRenames,
	type InstalledArtifacts,
	type InstalledSource,
	type Isolation,
	namedLogin,
	type Phases,
	phased,
	unserved,
	rostersOf,
	sameLevel,
	transactionClock,
	unrepresentableKeys
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
	generateMigration,
	type GenerateResult,
	type Installation,
	installationOver,
	lossText,
	type MigrationDraft,
	type MigrationFolder,
	type ProgramFootprints,
	type ServedWorkloadPlan,
	servedWorkload,
	servedWorkloadExtension,
	type Spellings,
	writeRuntimeSnapshot,
	writeSnapshot
} from "#compiler/plan/migration.ts"
import {
	type DeploySnapshot,
	derivedHolds,
	everySlice,
	type InstallBasis,
	installationsOf,
	installBasis,
	isEmptySnapshot,
	noWorkload,
	recordHolds,
	rosterFates,
	snapshotFileName,
	type SnapshotFiles,
	spellingsOf
} from "#compiler/plan/serve.ts"

interface GenerateOptions {
	readonly mode: GenerateMode
	/** A declared schema name or PostgreSQL schema identifier of the configuration, or none for every schema. */
	readonly schema: Option.Option<string>
	/** The draft's declared renames and drops (renames.ts), each the one chosen schema's. */
	readonly declared: Declarations
	readonly now: DateTime.Utc
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
 * the phased files and meta.json; this command supplies the clock (clock.ts) and writes the result (files.ts):
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
 * each login of the configuration over the schema has its workload compiled under that snapshot (servedFiles), and its
 * `served/<login>.json` and its OpenAPI document `openapi/<login>.json`, read off that served file, are written where
 * the directory does not hold that text, and the files of a login the configuration no longer lists are removed. A
 * custom folder changes no snapshot and compiles nothing, so it leaves them.
 *
 * Every selected schema drafts before anything is written, so a schema the compiler refuses writes no folder of any
 * schema, and a name the previous snapshot holds that the schema no longer does is refused unless the command line
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
export const draftRefused =
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
 * What a draft does to a schema's directory of one kind of login file: each login's file whose text the directory does
 * not hold, written, and the file of each login the configuration no longer lists over the schema, removed, by its
 * declared name.
 */
interface LoginWrites {
	readonly write: ReadonlyArray<LoginText>
	readonly remove: ReadonlyArray<string>
}

/** What a draft does to a schema's directories of login files, by kind (files.ts loginFiles). */
export type ServedWrites = { readonly [K in LoginFileKind]: LoginWrites }

/** A custom folder leaves the login files as they are. */
const noServedWrites: ServedWrites = {
	served: { write: [], remove: [] },
	openapi: { write: [], remove: [] }
}

/** A schema's draft: nothing to write; snapshot.json written again, its derived facts the compile's, with no folder; an
 * empty custom folder; or a drafted folder and its new snapshot's files. Beside any of them but the custom folder, the
 * served files of the snapshot the schema's directory commits once the draft is written. */
export type SchemaDraft = (
	| { readonly kind: "unchanged" }
	| { readonly kind: "rederived"; readonly snapshotFiles: SnapshotFiles }
	| { readonly kind: "custom"; readonly folder: MigrationFolder }
	| {
			readonly kind: "drafted"
			readonly folder: MigrationFolder
			readonly snapshotFiles: SnapshotFiles
	  }
) & {
	readonly schema: ConfiguredSchema
	/** The snapshot the schema's directory commits once the draft is written. */
	readonly snapshot: DeploySnapshot
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
	| {
			readonly kind: "logins"
			readonly logins: ReadonlyMap<string, PlannedLogin>
			readonly certification: ServedWorkloadPlan["certification"]
			readonly fences: ServedWorkloadPlan["fences"]
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
 * the types the workload's plan declares (WorkloadPhysical.params), which the installation drafted installs and its
 * snapshot records. The plan, with what each login's served file compiles over (ServedBasis): each role's change
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
	codes: Codebook,
	phases: Phases
) {
	const { configured, logins } = schema
	const refusedAt = (step: DraftRefused["step"]) => draftRefused(configured.declared, step)
	const configuredArtifacts = yield* Effect.mapError(
		fromEngine(artifactsOver(basis, unserved)),
		refusedAt("workload")
	)
	const options = {
		artifacts: configuredArtifacts,
		roles: Arr.flatMap(logins, (l) => l.owned.roles)
	}
	const { plan: workload, frontends } = yield* Effect.mapError(
		fromEngine(
			phased(phases, { name: "workload", of: [] }, () =>
				planWorkload(
					Arr.map(logins, (l) => ({ login: l.owned.name, workloads: l.login.workload })),
					configured.built,
					options,
					phases
				)
			)
		),
		(refused) => refusedAt("workload")(refused.error)
	)
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
	 * levels (metis's measure-full at changes start: 21 logins' artifacts, 40 to 63 MB each, 807 MB, none shared).
	 */
	const below: Array<{
		readonly content: typeof configured.built.content
		readonly artifacts: InstalledArtifacts
	}> = []
	const artifactsOf = (l: (typeof logins)[number]): Effect.Effect<InstalledArtifacts, CliError> => {
		if (sameLevel(l.login.base.content, configured.built.content)) {
			return Effect.succeed(servedArtifacts)
		}
		const known = Arr.findFirst(below, (b) => sameLevel(b.content, l.login.base.content))
		return Option.isSome(known)
			? Effect.succeed(known.value.artifacts)
			: Effect.mapBoth(
					fromEngine(
						artifactsUnder(l.owned.base, codes, derived, everySlice(l.owned.base), params)
					),
					{
						onFailure: refusedAt("workload"),
						onSuccess: (layer) => {
							below.push({ content: l.login.base.content, artifacts: layer.artifacts })
							return layer.artifacts
						}
					}
				)
	}
	const served = yield* Effect.forEach(logins, (l) =>
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
					Arr.map(served, ({ login: l, named, artifacts }) => ({
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
							schema: configured.declared,
							login: refused.login,
							...atRole(refused.refused)
						})
					)
	)
	const basisOf: ServedBasis = {
		kind: "logins",
		certification: plan.certification,
		fences: plan.fences,
		logins: new Map(
			Arr.map(served, ({ login: l, artifacts }) => {
				const roles = plan.changes.get(l.owned.name)
				const footprints = plan.footprints.get(l.owned.name)
				if (roles === undefined || footprints === undefined) {
					throw defect(`the change compile of login ${l.owned.name}, a login of the plan`)
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
	return { plan: installed, served: basisOf }
})

/**
 * What the draft of a schema's change from `previous` is drafted from: its schema compiled with every installer
 * extension a deployment needs and its logins' workloads' access paths, with the schemas it abandons (abandonedSchemas)
 * and the renames and drops `declared` declares. Everything is compiled under the codes the draft gives the schema's
 * rosters, drafted from the codes `previous` records, each under the name of the roster it continues as
 * (deploy/snapshot/build.ts rosterFates), and the declared handle renames (ir/codes.ts draftCodebook), and the spellings
 * `previous` records of its pattern languages (spellingsOf), each language's history as a roster's codes are: a
 * roster's codes are its history, so a handle keeps its code, a renamed one its old one's, a removed one leaves a hole
 * and a new one takes the next, and an ordered roster declared out of its codes' order is RosterReordered
 * (installationUnder).
 */
const draftInput = Effect.fn("draftInput")(function* (
	schema: CompiledSchema,
	previous: DeploySnapshot,
	abandoned: ReadonlyArray<AbandonedSchema>,
	declared: Declarations,
	phases: Phases
): Effect.fn.Return<{ readonly input: DraftInput; readonly served: ServedBasis }, CliError> {
	const rosters = rostersOf(schema.owned)
	const renames = yield* Effect.mapError(
		Effect.fromResult(rosterRenames(declared, rosters)),
		cliError
	)
	const compiled = yield* installationUnder(
		schema,
		{
			previous: rosterFates(
				previous,
				declared,
				Arr.map(rosters, (r) => r.closed)
			),
			renames,
			spellings: spellingsOf(previous)
		},
		phases
	)
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
 * pattern language; a committed snapshot's, or the live database's (cli/upgrade.ts).
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
 * plan (plannedLogins), and its other programs once the draft lays out its snapshot (servedFiles). The basis, the
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
	const { configured, owned, logins } = schema
	const rosters = rostersOf(owned)
	const drafted = draftCodebook(history.previous, history.renames, rosters, history.spellings)
	if (!drafted.ok) {
		const { roster, earlier, later } = drafted.error
		return yield* cliError(
			new RosterReordered({ schema: configured.declared, roster, earlier, later })
		)
	}
	const codes = drafted.value
	const refusedAt = (step: DraftRefused["step"]) => draftRefused(configured.declared, step)
	const basis = yield* Effect.mapError(
		fromEngine(
			phased(phases, { name: "basis", of: [] }, () => installBasis(owned, codes, everySlice(owned)))
		),
		refusedAt("schema")
	)
	/** The unrepresentable keys the schema's compile met so far, which a refusal of its logins' workloads, met after
	 * them, gives way to (engine core/canonical.ts metFirst). */
	const unrepresentable = basis.model.unrepresentable
	const planned = Arr.isReadonlyArrayNonEmpty(logins)
		? yield* Effect.catch(plannedLogins(schema, basis, codes, phases), (refused) =>
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
				: {
						access: planned.plan.access,
						accessPaths: planned.plan.requests,
						live: planned.plan.live
					},
		served: planned === undefined ? { kind: "noLogin" } : planned.served
	}
})

/**
 * The draft of a schema's change from `previous` under `declared`, its folder unnamed, as `grizzle check` compares it
 * with the committed snapshot (draftInput, then the pure generator's draftMigration), beside the installation it drafts
 * against, whose constants check holds the migrations' literal packs to. Nothing is written.
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
	const { input, served } = yield* draftInput(schema, previous, abandoned, declared, phases)
	const draft = yield* Effect.mapError(
		fromEngine(phased(phases, { name: "draft", of: [] }, () => draftMigration(input))),
		draftRefused(schema.configured.declared, "draft")
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
	Drafted<MigrationDraft> & { readonly installation: Installation; readonly served: ServedBasis },
	CliError
> =>
	Effect.map(draftSchema(...args), (draft) => ({
		...keptOf(draft),
		installation: draft.installation,
		served: draft.served
	}))

/**
 * What the CLI keeps of a draft past the draft phase: what it changes, its folder, its snapshot and the derived facts
 * snapshot.json records, which the served files, check's findings and write read. The draft's plan (every step's
 * statement as its tree) and its decision record (every statement's tokens) are the draft's own, which nothing after it
 * reads, so they are left behind at the draft's end rather than held through the served files' compile and the write
 * (edullm's qti App at hub 5374a0575: the plan alone 217 MB of the 2.2 GB live as the served phase starts).
 */
type Drafted<D extends MigrationDraft | GenerateResult> = Pick<
	D,
	"change" | "folder" | "snapshot" | "derived"
>

/** A draft as the CLI keeps it (`Drafted`). */
export const keptOf = <D extends MigrationDraft | GenerateResult>(draft: D): Drafted<D> => ({
	change: draft.change,
	folder: draft.folder,
	snapshot: draft.snapshot,
	derived: draft.derived
})

/**
 * The draft of a schema's change from `previous` as `grizzle generate` writes it, its folder named by `naming` and
 * `timestamp` (draftInput, then the pure generator's generateMigration). Nothing is written.
 */
const generateSchema = Effect.fn("generateSchema")(function* (
	schema: CompiledSchema,
	previous: DeploySnapshot,
	naming: FolderNaming,
	timestamp: string,
	abandoned: ReadonlyArray<AbandonedSchema>,
	declared: Declarations,
	phases: Phases
): Effect.fn.Return<Drafted<GenerateResult> & { readonly served: ServedBasis }, CliError> {
	const { input, served } = yield* draftInput(schema, previous, abandoned, declared, phases)
	const generated = yield* Effect.mapError(
		fromEngine(
			phased(phases, { name: "draft", of: [] }, () =>
				generateMigration({ ...input, naming, timestamp })
			)
		),
		draftRefused(schema.configured.declared, "draft")
	)
	return { ...keptOf(generated), served }
})

/** What a draft's snapshot files are written from: its snapshot and the derived runtime facts snapshot.json records. */
type DraftSnapshot = Pick<MigrationDraft, "snapshot" | "derived">

/** The texts of a draft's snapshot files, which generate writes. */
export const snapshotFilesOf = (
	schema: CompiledSchema,
	draft: DraftSnapshot
): Effect.Effect<SnapshotFiles, CliError> =>
	Effect.mapError(
		fromEngine(writeSnapshot(draft.snapshot, draft.derived)),
		draftRefused(schema.configured.declared, "draft")
	)

/** A draft's snapshot files (snapshotFilesOf), refused where snapshot.json, which an application imports whole, is past
 * generatedFileMaxBytes (files.ts unsplitWithin); manifest.json is laid out in parts within it as it is written. */
const importedSnapshotFiles = (
	schema: ConfiguredSchema,
	compiled: CompiledSchema,
	draft: DraftSnapshot
): Effect.Effect<SnapshotFiles, CliError> =>
	Effect.tap(snapshotFilesOf(compiled, draft), (files) =>
		unsplitWithin(
			schema.declared,
			[{ file: snapshotFileName, text: files.snapshot }],
			generatedFileMaxBytes
		)
	)

/**
 * Each login's served file, in configured order: its workload compiled under the snapshot.json text the draft lays out,
 * the draft's (adapter/served/compile.ts servedEntry), over the artifacts `served` holds for it, its ChangeSets as the
 * draft's workload plan compiled them (PlannedLogin): a login over the schema's own level over the installation's
 * artifacts, and one over a level below, whose ownership is its own (cli/config.ts compileSchema), over that level's,
 * as the snapshot records them. generate writes them beside the snapshot and check holds the committed ones to them,
 * so both compile every login once, from the one text. A login whose workload does not compile is ServedRefused, at
 * the login, its role or its program. The served files are a phase reported to `phases` (`served`), each login's a
 * phase inside it (`servedLogin`).
 */
export const servedFiles = (
	schema: CompiledSchema,
	draft: DraftSnapshot,
	served: ServedBasis,
	phases: Phases
): Effect.Effect<ReadonlyArray<ServedEntry>, CliError> =>
	phasedEffect(phases, { name: "served", of: [] }, servedEntries(schema, draft, served, phases))

/** Each login's served file (servedFiles), each a phase reported to `phases`. */
const servedEntries = Effect.fn("servedFiles")(function* (
	schema: CompiledSchema,
	draft: DraftSnapshot,
	served: ServedBasis,
	phases: Phases
): Effect.fn.Return<ReadonlyArray<ServedEntry>, CliError> {
	if (served.kind === "noLogin") {
		return []
	}
	const text = yield* Effect.mapError(
		fromEngine(writeRuntimeSnapshot(draft.snapshot, draft.derived)),
		draftRefused(schema.configured.declared, "draft")
	)
	const read = readJson(text)
	if (!read.ok) {
		throw defect(`the snapshot.json a draft lays out reads as JSON: ${read.error.expected}`)
	}
	const snapshot = read.value
	return yield* Effect.forEach(schema.logins, (login) => {
		const planned = served.logins.get(login.owned.name)
		if (planned === undefined) {
			throw defect(`the plan of login ${login.owned.name}, a login of the configuration`)
		}
		return Effect.mapError(
			phasedEffect(
				phases,
				{ name: "servedLogin", of: [login.owned.name] },
				servedEntry(login, snapshot, planned.artifacts, planned.roles, planned.footprints)
			),
			(refusal) =>
				cliError(
					new ServedRefused({
						schema: schema.configured.declared,
						login: login.login.desc.name,
						place: refusal.place,
						error: refusal.error
					})
				)
		)
	})
})

/** The text of a login's file of `kind` its compile gives: its served file's, or its OpenAPI document's. */
export const loginText = (entry: ServedEntry, kind: LoginFileKind): TextChunks =>
	kind === "served" ? entry.text : entry.openapi

/**
 * What writing `served` does to directories holding the committed files `committed`, by kind and login (ServedWrites):
 * a login's file written where none is committed or the committed one's bytes part from its text, each committed file
 * read a block at a time and held to the text as it is read (files.ts matchesFile), never read whole.
 */
export const servedWrites = (
	schema: ConfiguredSchema,
	served: ReadonlyArray<ServedEntry>,
	committed: LoginPaths
): Effect.Effect<ServedWrites, CliError, FileSystem.FileSystem> => {
	const listed = new Set(Arr.map(served, (f) => f.login))
	const writes = (
		kind: LoginFileKind
	): Effect.Effect<LoginWrites, PlatformError.PlatformError, FileSystem.FileSystem> =>
		Effect.map(
			Effect.forEach(served, (f) => {
				const text = loginText(f, kind)
				const path = committed[kind].get(f.login)
				return path === undefined
					? Effect.succeed([{ login: f.login, text }])
					: Effect.map(matchesFile(path, text), (parting) =>
							parting.kind === "same" ? [] : [{ login: f.login, text }]
						)
			}),
			(written) => ({
				write: Arr.flatten(written),
				remove: Arr.filter(Arr.fromIterable(committed[kind].keys()), (login) => !listed.has(login))
			})
		)
	return Effect.mapError(
		Effect.all({ served: writes("served"), openapi: writes("openapi") }),
		(cause) =>
			cliError(new TreeUnread({ schema: schema.declared, directory: schema.directory, cause }))
	)
}

/** One schema's draft, computed without writing anything. */
const draftFor = Effect.fn("draftFor")(function* (
	config: ResolvedConfig,
	schema: ConfiguredSchema,
	options: GenerateOptions
): Effect.fn.Return<SchemaDraft, CliError, FileSystem.FileSystem | Path.Path> {
	const tree = yield* readSchemaTree(schema.declared, schema.directory)
	const committed = yield* committedSnapshot(schema, tree)
	const previous = committed.snapshot
	const chain = yield* continuedChain(schema, tree, previous)
	const timestamp = nextTimestamp(options.now, chain.timestamps)
	const mode = options.mode
	if (mode.kind === "custom") {
		const folder = yield* Effect.mapError(
			fromEngine(customMigration({ snapshot: previous, name: mode.name, timestamp })),
			draftRefused(schema.declared, "custom")
		)
		return {
			schema,
			folder,
			snapshot: previous,
			served: noServedWrites,
			certification: [],
			fences: [],
			kind: "custom"
		} satisfies SchemaDraft
	}
	const compiled = yield* Effect.fromResult(
		phased(options.phases, { name: "build", of: [] }, () => compileSchema(schema))
	)
	const generated = yield* generateSchema(
		compiled,
		previous,
		mode.naming,
		timestamp,
		isEmptySnapshot(previous) ? yield* abandonedSchemas(config) : [],
		options.declared,
		options.phases
	)
	const files = yield* servedFiles(compiled, generated, generated.served, options.phases)
	yield* unsplitWithin(
		schema.declared,
		Arr.flatMap(loginFileKinds, (kind) =>
			Arr.map(files, (f) => ({ file: loginFiles[kind].path(f.login), text: loginText(f, kind) }))
		),
		generatedFileMaxBytes
	)
	const served = yield* servedWrites(schema, files, tree.logins)
	const certification = generated.served.kind === "logins" ? generated.served.certification : []
	const fences = generated.served.kind === "logins" ? generated.served.fences : []
	if (generated.change === "none") {
		return committed.kind === "files" &&
			(!derivedHolds(committed.derived, generated.derived) ||
				!recordHolds(committed.snapshot, generated.snapshot))
			? ({
					schema,
					snapshot: previous,
					snapshotFiles: yield* importedSnapshotFiles(schema, compiled, generated),
					served,
					certification,
					fences,
					kind: "rederived"
				} satisfies SchemaDraft)
			: ({
					schema,
					snapshot: previous,
					served,
					certification,
					fences,
					kind: "unchanged"
				} satisfies SchemaDraft)
	}
	return {
		schema,
		folder: generated.folder,
		snapshot: generated.snapshot,
		snapshotFiles: yield* importedSnapshotFiles(schema, compiled, generated),
		served,
		certification,
		fences,
		kind: "drafted"
	} satisfies SchemaDraft
})

/**
 * The schemas a schema's first draft abandons: each directory of the migrations directory, holding a snapshot.json, of a
 * schema the configuration no longer lists. A schema renamed in code is a new PostgreSQL schema, which the draft
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
		const entries = yield* fs.readDirectory(config.migrations)
		for (const name of Arr.sort(entries, Order.String)) {
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

/** Writes a draft: its folder whole, then its snapshot, then its served files and OpenAPI documents. */
export const writeDraft = Effect.fn("writeDraft")(function* (
	draft: SchemaDraft
): Effect.fn.Return<SchemaGenerateReport, CliError, FileSystem.FileSystem | Path.Path> {
	const { schema } = draft
	const schemaWritten = yield* writeSchemaDraft(draft)
	const files = yield* Effect.forEach(loginFileKinds, (kind) =>
		writeLoginFiles(
			schema.declared,
			kind,
			schema.directory,
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
		fingerprint: draft.snapshot.fingerprint,
		served: written,
		unserved: removed,
		certification: draft.certification,
		fences: draft.fences
	}
})

/** Writes a draft's folder whole, then its snapshot. */
const writeSchemaDraft = Effect.fn("writeSchemaDraft")(function* (
	draft: SchemaDraft
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
			snapshotPaths: yield* writeSnapshotFiles(
				schema.declared,
				schema.directory,
				draft.snapshotFiles,
				generatedFileMaxBytes
			),
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
		path: yield* writeFolder(schema.declared, schema.directory, folder, generatedFileMaxBytes),
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
	if (draft.kind === "custom") {
		const custom: SchemaWritten = { ...written, kind: "custom" }
		return custom
	}
	const drafted: SchemaWritten = {
		...written,
		kind: "drafted",
		snapshotPaths: yield* writeSnapshotFiles(
			schema.declared,
			schema.directory,
			draft.snapshotFiles,
			generatedFileMaxBytes
		)
	}
	return drafted
})

export const generateMigrations = Effect.fn("generate")(function* (
	config: ResolvedConfig,
	options: GenerateOptions
): Effect.fn.Return<
	ReadonlyArray<SchemaGenerateReport>,
	CliError,
	FileSystem.FileSystem | Path.Path
> {
	const schemas = yield* Effect.fromResult(selectSchemas(config, options))
	const drafts: Array<SchemaDraft> = []
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
			writeDraft(d)
		)
		reports.push(report)
	}
	return reports
})
