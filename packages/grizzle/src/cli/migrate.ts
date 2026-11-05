import { Array as Arr, Effect, type FileSystem, type Path } from "effect"
import { applyMigrations, checkDriftOf, type SchemaApplyReport } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import type { MigrationConnection } from "#adapter/migrate/session.ts"
import { committedSnapshot } from "#cli/committed.ts"
import type { ResolvedConfig } from "#cli/config.ts"
import type { CliError } from "#cli/errors.ts"
import { readSchemaTree } from "#cli/files.ts"

/** Every configured schema's migration target, read before connecting. */
const readTargets = (
	config: ResolvedConfig
): Effect.Effect<ReadonlyArray<MigrationTarget>, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.forEach(config.schemas, (schema) =>
		Effect.gen(function* () {
			const tree = yield* readSchemaTree(schema.declared, schema.directory)
			const snapshot = yield* committedSnapshot(schema, tree)
			return { snapshot, folders: tree.folders } satisfies MigrationTarget
		})
	)

/**
 * `grizzle migrate` and `grizzle drift`.
 *
 * The command takes no flags. Where to connect comes first (run.ts, connection.ts migrationConnection), so a connection
 * or a process environment it refuses is refused before any check runs or any directory is read; then every check
 * `grizzle check` runs (run.ts); then it reads every configured schema's directory, its snapshot.json and its folders
 * as text (files.ts, committed.ts), and hands them and the connection to the apply runner
 * (packages/grizzle/src/adapter/migrate), which connects as the migration identity and, for every schema in configured order, checks
 * before any statement of any folder runs that the role owns the schema, that the apply lock is free, that the ledger's
 * chain continues into the folders, that every applied file is still the text that ran, and that no file holds a
 * marker; then runs each pending file in its transaction or statement by statement, recording each as it completes, so
 * a rerun resumes at a failed file; and admits the catalog against the snapshot afterwards, refusing drift. The runner
 * applies exactly the texts read here.
 *
 * `grizzle drift` is handed its connection first too, and reads the same targets the same way, then runs only the drift
 * check of every schema (packages/grizzle/src/adapter/migrate checkDriftOf): no apply lock, no file run, nothing
 * committed. A folder not yet applied is a mismatch of its own.
 *
 * Applies every configured schema's pending migrations, connecting with `connection`, the configuration's.
 *
 * @internal
 */
export const migrate = Effect.fn("migrate")(function* (
	config: ResolvedConfig,
	connection: MigrationConnection
): Effect.fn.Return<
	ReadonlyArray<SchemaApplyReport>,
	CliError | MigrateError,
	FileSystem.FileSystem | Path.Path
> {
	const targets = yield* readTargets(config)
	return yield* applyMigrations({ connection, targets })
})

/**
 * Checks every configured schema's catalog against its committed snapshot, applying nothing; it connects with
 * `connection`, as migrate does.
 *
 * @internal
 */
export const drift = Effect.fn("drift")(function* (
	config: ResolvedConfig,
	connection: MigrationConnection
): Effect.fn.Return<
	ReadonlyArray<DriftReport>,
	CliError | MigrateError,
	FileSystem.FileSystem | Path.Path
> {
	const targets = yield* readTargets(config)
	yield* checkDriftOf({ connection, targets })
	return Arr.map(targets, (t) => ({
		schema: t.snapshot.schema,
		fingerprint: t.snapshot.fingerprint
	}))
})

/** A schema whose catalog matched its snapshot. */
export interface DriftReport {
	readonly schema: string
	readonly fingerprint: string
}
