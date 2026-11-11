import { Array as Arr, Effect, type FileSystem, type Path } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import type { ResolvedConfig } from "#cli/config.ts"
import { type CliError, cliError, ServedRefused } from "#cli/errors.ts"
import { readSchemaTree, writeLoginFiles } from "#cli/files.ts"
import { trustedJson } from "#compiler/plan/common.ts"
import { openApiText } from "#compiler/plan/migration.ts"
import { servedFile } from "#compiler/plan/serve.ts"

/**
 * `grizzle openapi`: each configured schema's committed served files' OpenAPI documents (live/openapi.ts), read off each
 * served file alone, as DbLayer.make reads one, compiling nothing: each written to `openapi/<login>.json` where the
 * directory does not hold that text, and the document of a login with no served file removed. It returns the paths
 * written and removed. `grizzle generate` writes the same documents beside the served files it writes, and `grizzle
 * check` holds them to the served files it compiles.
 */
export const openApiDocuments = (
	config: ResolvedConfig
): Effect.Effect<
	{ readonly written: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> },
	CliError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.map(
		Effect.forEach(config.schemas, (schema) =>
			Effect.gen(function* () {
				const tree = yield* readSchemaTree(schema.declared, schema.directory)
				const documents = yield* Effect.forEach(tree.logins.served, ([login, text]) =>
					Effect.mapBoth(fromEngine(openApiText(servedFile(trustedJson<unknown>(text)))), {
						onFailure: (error) =>
							cliError(
								new ServedRefused({
									schema: schema.declared,
									login,
									place: { kind: "login" },
									error
								})
							),
						onSuccess: (document) => ({ login, text: document })
					})
				)
				return yield* writeLoginFiles(
					schema.declared,
					"openapi",
					schema.directory,
					Arr.filter(documents, (d) => tree.logins.openapi.get(d.login) !== d.text),
					Arr.filter(
						Arr.fromIterable(tree.logins.openapi.keys()),
						(login) => !tree.logins.served.has(login)
					)
				)
			})
		),
		(schemas) => ({
			written: Arr.flatMap(schemas, (s) => s.written),
			removed: Arr.flatMap(schemas, (s) => s.removed)
		})
	)
