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
import type { GenerateMode } from "#cli/args.ts"
import { nextTimestamp } from "#cli/clock.ts"
import { committedSnapshot, continuedChain } from "#cli/committed.ts"
import type { ConfiguredSchema, ResolvedConfig } from "#cli/config.ts"
import {
	type CliError,
	DraftRefused,
	MigrationNameRefused,
	MigrationsUnread,
	cliError,
	SchemaChoiceRefused
} from "#cli/errors.ts"
import { readSchemaTree, writeFolder, writeSnapshotFile } from "#cli/files.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Engine from "#compiler/core/result.ts"
import type { AbandonedSchema } from "#compiler/deploy/diff/plan.ts"
import { lossText } from "#compiler/deploy/render/chosen.ts"
import {
	type FolderNaming,
	folderName,
	type MigrationFolder
} from "#compiler/deploy/render/folder.ts"

import {
	customMigration,
	type GenerateResult,
	generateMigration
} from "#compiler/deploy/render/generate.ts"
import { findMarkers } from "#compiler/deploy/render/markers.ts"
import { isEmptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { type DeploySnapshot, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { compileWorkload } from "#compiler/program/workload/compile.ts"

interface GenerateOptions {
	readonly mode: GenerateMode
	/** A declared schema name or PostgreSQL schema identifier of the configuration, or none for every schema. */
	readonly schema: Option.Option<string>
	readonly now: DateTime.Utc
}

interface DraftMarker {
	readonly file: string
	readonly kind: "placeholder" | "rename"
	readonly line: number
}

/** A loss of stored data a drafted folder leaves to the reviewer: its file, and what it loses (chosen.ts lossText). */
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
 * (committed.ts), compiles the schema with every installer extension a deployment needs, its residual laws, its
 * derived relations, its logins' workloads' access paths and statistics and its logins' worlds, and hands the
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
 * data steps, named `--name` or `custom`; snapshot.json does not change.
 *
 * Every selected schema drafts before anything is written, so a schema the compiler refuses writes no folder of any
 * schema. The report lists each written file, each unresolved marker, the placeholders and candidate renames a reviewer
 * must settle, and each loss of stored data a reviewer must decide, before `grizzle check` and `grizzle migrate` accept
 * the folder. A schema's first draft beside the migrations of schemas the configuration no longer lists, which a schema
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
	options: Pick<GenerateOptions, "schema" | "mode">
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
	if (options.mode.kind === "custom" && config.schemas.length > 1) {
		return refuseChoice({ kind: "unchosen", schemas })
	}
	return Result.succeed(config.schemas)
}

/** A schema's draft: nothing to write; an empty custom folder; or a drafted folder and its new snapshot.json text. */
type Draft = (
	| { readonly kind: "unchanged" }
	| { readonly kind: "custom"; readonly folder: MigrationFolder }
	| { readonly kind: "drafted"; readonly folder: MigrationFolder; readonly snapshotText: string }
) & {
	readonly schema: ConfiguredSchema
	/** The snapshot the schema's directory commits once the draft is written. */
	readonly snapshot: DeploySnapshot
}

/**
 * The draft of a schema's change from `previous`: its schema compiled with every installer extension a deployment
 * needs and its logins' workloads' access paths, handed to the pure generator with the schemas it abandons (abandonedSchemas).
 * Nothing is written.
 *
 * @internal
 */
export const draftSchema = Effect.fn("draftSchema")(function* (
	schema: ConfiguredSchema,
	previous: DeploySnapshot,
	naming: FolderNaming,
	timestamp: string,
	abandoned: ReadonlyArray<AbandonedSchema>
): Effect.fn.Return<GenerateResult, CliError> {
	/**
	 * The logins' workloads and their roles' write filters, planned under the configured schema's artifacts and
	 * the names the installation drafted below gives it, so the index requests name its vector schema. A schema
	 * without a login plans nothing.
	 */
	const roles = Arr.flatMap(schema.logins, (l) => l.roles)
	const plan =
		schema.logins.length === 0
			? undefined
			: yield* Effect.mapError(
					fromEngine(
						Engine.flatMap(parseSchemaInput(schema.owned), (input) =>
							Engine.flatMap(
								schemaArtifacts(input, { installation: undefined, vectorSchema: undefined }),
								(artifacts) => compileWorkload(schema.workloads, input, { artifacts, roles })
							)
						)
					),
					draftRefused(schema.declared, "workload")
				)
	const installation = yield* Effect.mapError(
		fromEngine(
			compileInstallation(
				schema.owned,
				completeInstallOptions(
					schema.owned,
					schema.owned.installation,
					schema.logins,
					plan === undefined ? [] : [workloadExtension(plan)]
				)
			)
		),
		draftRefused(schema.declared, "schema")
	)
	return yield* Effect.mapError(
		fromEngine(
			generateMigration({
				previous,
				installation,
				workload:
					plan === undefined ? noWorkload : { access: plan.access, accessPaths: plan.requests },
				naming,
				timestamp,
				abandoned
			})
		),
		draftRefused(schema.declared, "draft")
	)
})

/** One schema's draft, computed without writing anything. */
const draftFor = Effect.fn("draftFor")(function* (
	config: ResolvedConfig,
	schema: ConfiguredSchema,
	options: GenerateOptions
): Effect.fn.Return<Draft, CliError, FileSystem.FileSystem | Path.Path> {
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
		return { schema, folder, snapshot: previous, kind: "custom" } satisfies Draft
	}
	const generated = yield* draftSchema(
		schema,
		previous,
		mode.naming,
		timestamp,
		isEmptySnapshot(previous) ? yield* abandonedSchemas(config) : []
	)
	if (generated.change === "none") {
		return { schema, snapshot: previous, kind: "unchanged" } satisfies Draft
	}
	return {
		schema,
		folder: generated.folder,
		snapshot: generated.snapshot,
		snapshotText: generated.snapshotText,
		kind: "drafted"
	} satisfies Draft
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
	draft: Draft
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

/**
 * The folder name a mode gives, which generate checks before anything is compiled: a custom folder's, or a draft's
 * `--name`; none for a draft named after its change.
 */
const givenName = (mode: GenerateMode): Option.Option<string> => {
	switch (mode.kind) {
		case "custom":
			return Option.some(mode.name)
		case "draft":
			return mode.naming.kind === "named" ? Option.some(mode.naming.name) : Option.none()
	}
}

/**
 * The refusal of a mode's folder name, checked before anything is compiled, or none when its shape is a folder name's
 * or the draft is named after its change; the timestamp only stands in.
 */
const nameRefusal = (mode: GenerateMode): Option.Option<CliError> =>
	Option.map(
		Option.filter(givenName(mode), (name) => !folderName("00000000000000", name).ok),
		(name) => cliError(new MigrationNameRefused({ migration: name }))
	)

/** @internal */
export const generate = Effect.fn("generate")(function* (
	config: ResolvedConfig,
	options: GenerateOptions
): Effect.fn.Return<
	ReadonlyArray<SchemaGenerateReport>,
	CliError,
	FileSystem.FileSystem | Path.Path
> {
	const refusal = nameRefusal(options.mode)
	if (Option.isSome(refusal)) {
		return yield* refusal.value
	}
	const schemas = yield* Effect.fromResult(selectSchemas(config, options))
	const drafts: Array<Draft> = []
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
