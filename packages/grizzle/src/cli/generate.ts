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
import { type ServedEntry, servedEntry } from "#adapter/served/compile.ts"
import { artifactsOver } from "#adapter/served/login.ts"
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
	ServedRefused
} from "#cli/errors.ts"
import {
	readSchemaTree,
	type ServedText,
	writeFolder,
	writeServedFiles,
	writeSnapshotFiles
} from "#cli/files.ts"
import { rosterRenames } from "#cli/renames.ts"
import {
	type CompileError,
	draftCodebook,
	Engine,
	rostersOf,
	trustedJson
} from "#compiler/plan/common.ts"
import {
	type AbandonedSchema,
	compileWorkload,
	completeInstallOptions,
	customMigration,
	type Declarations,
	type DraftInput,
	draftMigration,
	findMarkers,
	type FolderNaming,
	generateMigration,
	type GenerateResult,
	type Installation,
	installationOver,
	lossText,
	type MigrationDraft,
	type MigrationFolder,
	workloadExtension
} from "#compiler/plan/migration.ts"
import {
	type DeploySnapshot,
	derivedHolds,
	everySlice,
	installationsOf,
	installBasis,
	isEmptySnapshot,
	noWorkload,
	rosterFates,
	snapshotFileName,
	type SnapshotFiles
} from "#compiler/plan/serve.ts"

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
 *   derivedHolds): then snapshot.json is written again with them, with no folder, since no fact is part of the
 *   fingerprinted content;
 * - otherwise the folder `<migrations>/<schema>/<timestamp>_<name>/` is written whole, then manifest.json and
 *   snapshot.json are replaced by the new snapshot's. A folder may hold no SQL file when only the snapshot changed, such as a workload program whose
 *   access moved onto an index that already exists. Its name is `--name`, else derived from the change (compiler/deploy/render/naming.ts).
 *
 * A custom migration is the empty folder whose source and target are both the committed snapshot, for hand-written
 * data steps, named `--name`; the snapshot's files do not change.
 *
 * Beside the snapshot, every other draft brings the schema's served directory to the snapshot it commits: each login of
 * the configuration over the schema has its workload compiled under that snapshot (servedFiles), and its
 * `served/<login>.json` is written where the directory does not hold that text, and the served file of a login the
 * configuration no longer lists is removed. A custom folder changes no snapshot and compiles nothing, so it leaves them.
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
	/** The path of each served file written, its text not the one the directory held. */
	readonly served: ReadonlyArray<string>
	/** The path of each served file removed, of a login the configuration no longer lists over the schema. */
	readonly unserved: ReadonlyArray<string>
}

/** What writing a draft's folder and snapshot wrote (Written), with the folder's files, markers and losses. */
type SchemaWritten = Written & {
	/** The folder's SQL files, by name; none when nothing was written. */
	readonly files: ReadonlyArray<string>
	readonly markers: ReadonlyArray<DraftMarker>
	/** Each loss of stored data the folder drafts, by file, with what it loses. */
	readonly losses: ReadonlyArray<DraftLoss>
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
 * What a draft does to a schema's served directory: each login's served file whose text the directory does not hold,
 * written, and the served file of each login the configuration no longer lists over the schema, removed, by its
 * declared name.
 */
interface ServedWrites {
	readonly write: ReadonlyArray<ServedText>
	readonly remove: ReadonlyArray<string>
}

/** A custom folder leaves the served files as they are. */
const noServedWrites: ServedWrites = { write: [], remove: [] }

/** A schema's draft: nothing to write; snapshot.json written again, its derived facts the compile's, with no folder; an
 * empty custom folder; or a drafted folder and its new snapshot's files. Beside any of them but the custom folder, the
 * served files of the snapshot the schema's directory commits once the draft is written. */
type SchemaDraft = (
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
}

/**
 * What the draft of a schema's change from `previous` is drafted from: its schema compiled with every installer
 * extension a deployment needs and its logins' workloads' access paths, with the schemas it abandons (abandonedSchemas)
 * and the renames and drops `declared` declares. Everything is compiled under the codes the draft gives the schema's
 * rosters, drafted from the codes `previous` records, each under the name of the roster it continues as
 * (deploy/snapshot/build.ts rosterFates), and the declared handle renames (ir/codes.ts draftCodebook): a
 * roster's codes are its history, so a handle keeps its code, a renamed one its old one's, a removed one leaves a hole
 * and a new one takes the next, and a roster declared out of its codes' order is RosterReordered.
 * The schema's basis is compiled once: the artifacts the workloads' access paths are planned against and the
 * installation the draft installs share one law model and one plan of the closed constants (physical/install/plan.ts
 * installBasis). Each login's programs are compiled once the draft lays out its snapshot (servedFiles).
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
	const basis = yield* Effect.mapError(
		fromEngine(installBasis(owned, codes, everySlice(owned))),
		refusedAt("schema")
	)
	/**
	 * The logins' workloads and their roles' write filters, planned under the configured schema's artifacts and
	 * the names the installation drafted below gives it, so the index requests name its vector schema. A schema
	 * without a login plans nothing.
	 */
	const planned = Arr.isReadonlyArrayNonEmpty(logins)
		? yield* Effect.mapError(
				fromEngine(
					Engine.flatMap(artifactsOver(basis), (artifacts) =>
						compileWorkload(
							Arr.map(logins, (l) => ({ login: l.owned.name, workloads: l.login.workload })),
							configured.built,
							{ artifacts, roles: Arr.flatMap(logins, (l) => l.owned.roles) }
						)
					)
				),
				refusedAt("workload")
			)
		: undefined
	const options = completeInstallOptions(
		owned,
		installationsOf(owned),
		Arr.map(logins, (l) => l.owned),
		planned === undefined ? [] : [workloadExtension(planned)],
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
				: { access: planned.access, accessPaths: planned.requests },
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

/**
 * Each login's served file, in configured order: its workload compiled under the snapshot.json text `files` lays out,
 * the draft's, as DbLayer.make read it (adapter/served/compile.ts servedEntry). generate writes them beside the snapshot
 * and check holds the committed ones to them, so both compile every login once, from the one text. A login whose
 * workload does not compile is ServedRefused, at the login, its role or its program.
 */
export const servedFiles = Effect.fn("servedFiles")(function* (
	schema: CompiledSchema,
	files: SnapshotFiles
): Effect.fn.Return<ReadonlyArray<ServedEntry>, CliError> {
	const snapshot = trustedJson<unknown>(files.snapshot)
	return yield* Effect.forEach(schema.logins, (login) =>
		Effect.mapError(servedEntry(login, snapshot), (refusal) =>
			cliError(
				new ServedRefused({
					schema: schema.configured.declared,
					login: login.login.desc.name,
					place: refusal.place,
					error: refusal.error
				})
			)
		)
	)
})

/** What writing `served` does to a served directory holding `committed`, by login (ServedWrites). */
const servedWrites = (
	served: ReadonlyArray<ServedEntry>,
	committed: ReadonlyMap<string, string>
): ServedWrites => {
	const listed = new Set(Arr.map(served, (f) => f.login))
	return {
		write: Arr.filter(served, (f) => committed.get(f.login) !== f.text),
		remove: Arr.filter(Arr.fromIterable(committed.keys()), (login) => !listed.has(login))
	}
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
			kind: "custom"
		} satisfies SchemaDraft
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
	const files = yield* servedFiles(compiled, generated.snapshotFiles)
	const served = servedWrites(files, tree.served)
	if (generated.change === "none") {
		return committed.kind === "files" && !derivedHolds(committed.derived, generated.derived)
			? ({
					schema,
					snapshot: previous,
					snapshotFiles: generated.snapshotFiles,
					served,
					kind: "rederived"
				} satisfies SchemaDraft)
			: ({ schema, snapshot: previous, served, kind: "unchanged" } satisfies SchemaDraft)
	}
	return {
		schema,
		folder: generated.folder,
		snapshot: generated.snapshot,
		snapshotFiles: generated.snapshotFiles,
		served,
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

/** Writes a draft: its folder whole, then its snapshot, then its served files. */
const writeDraft = Effect.fn("writeDraft")(function* (
	draft: SchemaDraft
): Effect.fn.Return<SchemaGenerateReport, CliError, FileSystem.FileSystem | Path.Path> {
	const { schema } = draft
	const written = yield* writeSchemaDraft(draft)
	const served = yield* writeServedFiles(
		schema.declared,
		schema.directory,
		draft.served.write,
		draft.served.remove
	)
	return {
		...written,
		schema: schema.declared,
		ident: schema.ident,
		fingerprint: draft.snapshot.fingerprint,
		served: served.written,
		unserved: served.removed
	}
})

/** Writes a draft's folder whole, then its snapshot. */
const writeSchemaDraft = Effect.fn("writeSchemaDraft")(function* (
	draft: SchemaDraft
): Effect.fn.Return<SchemaWritten, CliError, FileSystem.FileSystem | Path.Path> {
	const { schema } = draft
	if (draft.kind === "unchanged") {
		const unchanged: SchemaWritten = { kind: "unchanged", files: [], markers: [], losses: [] }
		return unchanged
	}
	if (draft.kind === "rederived") {
		const rederived: SchemaWritten = {
			kind: "rederived",
			snapshotPaths: yield* writeSnapshotFiles(
				schema.declared,
				schema.directory,
				draft.snapshotFiles
			),
			files: [],
			markers: [],
			losses: []
		}
		return rederived
	}
	const folder = draft.folder
	const written = {
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
		const custom: SchemaWritten = { ...written, kind: "custom" }
		return custom
	}
	const drafted: SchemaWritten = {
		...written,
		kind: "drafted",
		snapshotPaths: yield* writeSnapshotFiles(schema.declared, schema.directory, draft.snapshotFiles)
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
