import { Array as Arr, Effect, FileSystem } from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"
import { Repository } from "#shared/repository.ts"

/**
 * The root tsconfig and each workspace package's tsconfig.json, for the packages that have one. It checks them
 * through Effect's FileSystem, which is unstable, and so is it.
 *
 * @stability unstable
 */
export const workspaceConfigs = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const repository = yield* Repository
	const packageConfigs = yield* Effect.filter(
		Arr.map(repository.packages, (leaf) => `${leaf}/tsconfig.json`),
		(config) => fs.exists(config)
	)
	return [`${repository.root}/tsconfig.json`, ...packageConfigs]
}).pipe(
	Effect.mapError((cause) =>
		DevtoolFailure.make({ detail: "The workspace tsconfigs could not be listed", cause })
	)
)
