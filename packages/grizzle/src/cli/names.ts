import { Array as Arr, Effect, type FileSystem, type Path } from "effect"
import { committedSnapshot } from "#cli/committed.ts"
import type { ResolvedConfig } from "#cli/config.ts"
import type { CliError } from "#cli/errors.ts"
import { readSchemaTree } from "#cli/files.ts"
import { printCommentTarget } from "#compiler/plan/common.ts"

/**
 * `grizzle names`: the mapping a direct SQL writer reads, from each configured schema's committed snapshot, offline.
 * Every object grizzle installs is named by the naming door (core/identity.ts): a readable name spells what it is, and a
 * hashed one's COMMENT holds its identity spelled out. Each line is one hashed object, as COMMENT ON names it, then that
 * text. A schema with no snapshot yet installs nothing.
 *
 * @internal
 */
export const names = (
	config: ResolvedConfig
): Effect.Effect<ReadonlyArray<string>, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.map(
		Effect.forEach(config.schemas, (schema) =>
			Effect.gen(function* () {
				const tree = yield* readSchemaTree(schema.declared, schema.directory)
				const snapshot = yield* committedSnapshot(schema, tree)
				return [
					`${schema.declared} in PostgreSQL schema ${schema.ident}:`,
					...Arr.flatMap(snapshot.manifest.comments, (c) =>
						c.kind === "comment" ? [`  ${printCommentTarget(c.on)}  ${c.text}`] : []
					)
				]
			})
		),
		Arr.flatten
	)
