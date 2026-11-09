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
import { fromEngine } from "#adapter/engine.ts"
import { artifactsOver, loginRoles } from "#adapter/pool/registry.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
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
	SchemaChoiceRefused
} from "#cli/errors.ts"
import { readSchemaTree, writeFolder, writeSnapshotFile } from "#cli/files.ts"
import { rosterRenames } from "#cli/renames.ts"
import { type CompileError, draftCodebook, Engine, rostersOf } from "#compiler/plan/common.ts"
import {
	type AbandonedSchema,
	compileWorkload,
	completeInstallOptions,
	customMigration,
	type Declarations,
	type DeploySnapshot,
	type DraftInput,
	draftMigration,
	findMarkers,
	type FolderNaming,
	generateMigration,
	type GenerateResult,
	type Installation,
	installationOver,
	installationsOf,
	installBasis,
	isEmptySnapshot,
	lossText,
	type MigrationDraft,
	type MigrationFolder,
	noWorkload,
	rosterFates,
	snapshotFileName,
	workloadExtension
} from "#compiler/plan/migration.ts"

interface GenerateOptions {
	readonly mode: GenerateMode
	/** A declared schema name or PostgreSQL schema identifier of the configuration, or none for every schema. */
	readonly schema: Option.Option<string>
	/** The draft's declared renames and drops (renames.ts), each the one chosen schema's. */
	readonly declared: Declarations
	readonly now: DateTime.Utc
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
 * What generate wrote for one schema: nothing; an empty custom folder, its name and path; or a drafted folder and the
 * snapshot.json it replaced.
 */
type Written =
	| { readonly kind: "unchanged" }
	| { readonly kind: "custom"; readonly folder: string; readonly path: string }
	| {
			readonly kind: "drafted"
			readonly folder: string
			readonly path: string
			readonly snapshotPath: string
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
 * - a schema whose target equals its previous snapshot drafts nothing and keeps its snapshot.json;
 * - otherwise the folder `<migrations>/<schema>/<timestamp>_<name>/` is written whole, then snapshot.json is replaced
 *   by the new snapshot. A folder may hold no SQL file when only the snapshot changed, such as a workload program whose
 *   access moved onto an index that already exists. Its name is `--name`, else derived from the change (compiler/deploy/render/naming.ts).
 *
 * A custom migration is the empty folder whose source and target are both the committed snapshot, for hand-written
 * data steps, named `--name`; snapshot.json does not change.
 *
 * Every selected schema drafts before anything is written, so a schema the compiler refuses writes no folder of any
 * schema, and a name the previous snapshot holds that the schema no longer does is refused unless the command line
 * declares it renamed or dropped (`--rename`, `--drop`). The report lists each written file, each marker a reviewer
 * must resolve (a placeholder to fill, a group of statements to confirm), and each loss of stored data a reviewer must
 * decide, before `grizzle check` and `grizzle migrate` accept the folder. A schema's first draft beside the migrations of schemas the configuration no longer lists, which a schema
 * renamed in code leaves, starts the schema under the loss of their rows (abandonedSchemas). generate never reads the
 * configuration's connection.
 */
export type SchemaGenerateReport = Written & {
	readonly schema: string
	readonly ident: string
	/** The folder's SQL files, by name; none when nothing was written. */
	readonly files: ReadonlyArray<string>
	readonly markers: ReadonlyArray<DraftMarker>
	/** Each loss of stored data the folder drafts, by file, with what it loses. */
	readonly losses: ReadonlyArray<DraftLoss>
	/** The snapshot the schema's directory now commits. */
	readonly fingerprint: string
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

/** A schema's draft: nothing to write; an empty custom folder; or a drafted folder and its new snapshot.json text. */
type SchemaDraft = (
	| { readonly kind: "unchanged" }
	| { readonly kind: "custom"; readonly folder: MigrationFolder }
	| { readonly kind: "drafted"; readonly folder: MigrationFolder; readonly snapshotText: string }
) & {
	readonly schema: ConfiguredSchema
	/** The snapshot the schema's directory commits once the draft is written. */
	readonly snapshot: DeploySnapshot
}

/**
 * What the draft of a schema's change from `previous` is drafted from: its schema compiled with every installer
 * extension a deployment needs and its logins' workloads' access paths, with the schemas it abandons (abandonedSchemas)
 * and the renames and drops `declared` declares. Everything is compiled under the codes the draft gives the schema's
 * rosters, drafted from the codes `previous` records, each under the name of the roster it continues as
 * (deploy/snapshot/build.ts rosterFates), and the declared handle renames (ir/codes.ts draftCodebook): a
 * roster's codes are its history, so a handle keeps its code, a renamed one its old one's, a removed one leaves a hole
 * and a new one takes the next, and a roster declared out of its codes' order is RosterReordered.
 * Beside the access paths, every program of each login's workloads is compiled for every role of the login exactly as
 * DbLayer.make compiles it (adapter/pool/registry.ts loginRoles), so a program the layer would refuse refuses the draft.
 * The schema's basis is compiled once: the artifacts the programs read and the installation the draft installs share
 * one law model and one plan of the closed constants (physical/install/plan.ts installBasis), and every login and
 * role reads the one artifacts.
 */
const draftInput = Effect.fn("draftInput")(function* (
	schema: CompiledSchema,
	previous: DeploySnapshot,
	abandoned: ReadonlyArray<AbandonedSchema>,
	declared: Declarations
): Effect.fn.Return<DraftInput, CliError> {
	const { configured, owned, logins } = schema
	const rosters = rostersOf(owned)
	const renames = yield* Effect.mapError(
		Effect.fromResult(rosterRenames(declared, rosters)),
		cliError
	)
	const drafted = draftCodebook(
		rosterFates(
			previous,
			declared,
			Arr.map(rosters, (r) => r.closed)
		),
		renames,
		rosters
	)
	if (!drafted.ok) {
		const { roster, earlier, later } = drafted.error
		return yield* cliError(
			new RosterReordered({ schema: configured.declared, roster, earlier, later })
		)
	}
	const codes = drafted.value
	const refusedAt = (step: DraftRefused["step"]) => draftRefused(configured.declared, step)
	const basis = yield* Effect.mapError(fromEngine(installBasis(owned, codes)), refusedAt("schema"))
	/**
	 * The logins' workloads and their roles' write filters, planned under the configured schema's artifacts and
	 * the names the installation drafted below gives it, so the index requests name its vector schema. A schema
	 * without a login plans nothing.
	 */
	const planned = Arr.isReadonlyArrayNonEmpty(logins)
		? yield* Effect.mapError(
				fromEngine(
					Engine.flatMap(artifactsOver(basis), (artifacts) =>
						Engine.map(
							compileWorkload(
								Arr.map(logins, (l) => ({ login: l.owned.name, workloads: l.login.workload })),
								configured.built,
								{ artifacts, roles: Arr.flatMap(logins, (l) => l.owned.roles) }
							),
							(plan) => ({ artifacts, plan })
						)
					)
				),
				refusedAt("workload")
			)
		: undefined
	if (planned !== undefined) {
		for (const login of logins) {
			yield* Effect.mapError(
				loginRoles(login.login, login.owned, planned.artifacts, noLevelAbove),
				refusedAt("workload")
			)
		}
	}
	const options = completeInstallOptions(
		owned,
		installationsOf(owned),
		Arr.map(logins, (l) => l.owned),
		planned === undefined ? [] : [workloadExtension(planned.plan)],
		codes
	)
	const installation = yield* Effect.mapError(
		fromEngine(installationOver(basis, options)),
		refusedAt("schema")
	)
	return {
		previous,
		installation,
		workload:
			planned === undefined
				? noWorkload
				: { access: planned.plan.access, accessPaths: planned.plan.requests },
		abandoned,
		declared
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
	declared: Declarations
): Effect.fn.Return<MigrationDraft & { readonly installation: Installation }, CliError> {
	const input = yield* draftInput(schema, previous, abandoned, declared)
	const draft = yield* Effect.mapError(
		fromEngine(draftMigration(input)),
		draftRefused(schema.configured.declared, "draft")
	)
	return { ...draft, installation: input.installation }
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
	declared: Declarations
): Effect.fn.Return<GenerateResult, CliError> {
	const input = yield* draftInput(schema, previous, abandoned, declared)
	return yield* Effect.mapError(
		fromEngine(generateMigration({ ...input, naming, timestamp })),
		draftRefused(schema.configured.declared, "draft")
	)
})

/** One schema's draft, computed without writing anything. */
const draftFor = Effect.fn("draftFor")(function* (
	config: ResolvedConfig,
	schema: ConfiguredSchema,
	options: GenerateOptions
): Effect.fn.Return<SchemaDraft, CliError, FileSystem.FileSystem | Path.Path> {
	const tree = yield* readSchemaTree(schema.declared, schema.directory)
	const previous = yield* committedSnapshot(schema, tree)
	const chain = yield* continuedChain(schema, tree, previous)
	const timestamp = nextTimestamp(options.now, chain.timestamps)
	const mode = options.mode
	if (mode.kind === "custom") {
		const folder = yield* Effect.mapError(
			fromEngine(customMigration({ snapshot: previous, name: mode.name, timestamp })),
			draftRefused(schema.declared, "custom")
		)
		return { schema, folder, snapshot: previous, kind: "custom" } satisfies SchemaDraft
	}
	const compiled = yield* Effect.fromResult(compileSchema(schema))
	const generated = yield* generateSchema(
		compiled,
		previous,
		mode.naming,
		timestamp,
		isEmptySnapshot(previous) ? yield* abandonedSchemas(config) : [],
		options.declared
	)
	if (generated.change === "none") {
		return { schema, snapshot: previous, kind: "unchanged" } satisfies SchemaDraft
	}
	return {
		schema,
		folder: generated.folder,
		snapshot: generated.snapshot,
		snapshotText: generated.snapshotText,
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

/** Writes a draft: its folder whole, then its snapshot. */
const writeDraft = Effect.fn("writeDraft")(function* (
	draft: SchemaDraft
): Effect.fn.Return<SchemaGenerateReport, CliError, FileSystem.FileSystem | Path.Path> {
	const { schema } = draft
	const common = {
		schema: schema.declared,
		ident: schema.ident,
		fingerprint: draft.snapshot.fingerprint
	}
	if (draft.kind === "unchanged") {
		const unchanged: SchemaGenerateReport = {
			...common,
			kind: "unchanged",
			files: [],
			markers: [],
			losses: []
		}
		return unchanged
	}
	const folder = draft.folder
	const written = {
		...common,
		folder: folder.name,
		path: yield* writeFolder(schema.declared, schema.directory, folder),
		files: Arr.map(folder.files, (f) => f.name),
		markers: Arr.flatMap(folder.files, (f) =>
			Arr.map(findMarkers(f.text), (m) => ({ file: f.name, kind: m.kind, line: m.line }))
		),
		losses:
			folder.meta.kind === "drafted"
				? Arr.flatMap(folder.meta.files, (f) =>
						Arr.flatMap(f.steps, (s) =>
							s.kind === "loss" ? [{ file: f.name, loses: lossText(s.loses) }] : []
						)
					)
				: []
	}
	if (draft.kind === "custom") {
		const custom: SchemaGenerateReport = { ...written, kind: "custom" }
		return custom
	}
	const drafted: SchemaGenerateReport = {
		...written,
		kind: "drafted",
		snapshotPath: yield* writeSnapshotFile(schema.declared, schema.directory, draft.snapshotText)
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
		const draft = yield* draftFor(config, s, options)
		drafts.push(draft)
	}
	const reports: Array<SchemaGenerateReport> = []
	for (const d of drafts) {
		const report = yield* writeDraft(d)
		reports.push(report)
	}
	return reports
})
