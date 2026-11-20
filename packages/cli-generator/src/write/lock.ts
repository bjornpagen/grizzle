import type { Scope } from "effect"
import { Effect, FileSystem, Path, PlatformError, Ref, Schema } from "effect"

/**
 * The lock file a run holds inside its output directory (design 3.6, Run lock).
 */
export const runLockFileName = ".openapi-cli-manifest.lock"

/**
 * Another run holds the lock; the generator maps this to exit 1 and prints `lockPath`.
 */
export class RunLockHeld extends Schema.TaggedError<
	RunLockHeld,
	{ readonly brand: unique symbol }
>()("RunLockHeld", { lockPath: Schema.String }) {}

/**
 * The lock could not be created for a reason other than another holder.
 */
export class RunLockUnavailable extends Schema.TaggedError<
	RunLockUnavailable,
	{ readonly brand: unique symbol }
>()("RunLockUnavailable", {
	lockPath: Schema.String,
	cause: Schema.instanceOf(PlatformError.PlatformError)
}) {}

/**
 * A held run lock: temp siblings registered here are removed when the scope closes.
 */
export interface RunLock {
	readonly lockPath: string
	readonly registerTemp: (path: string) => Effect.Effect<void>
}

const alreadyExists = (error: PlatformError.PlatformError): boolean =>
	error.reason._tag === "AlreadyExists"

/**
 * Claim the run lock in `outputDir`: `wx` creates `.openapi-cli-manifest.lock`, and the enclosing
 * scope removes the registered temp siblings and then the lock, on success, failure or interrupt.
 * A refused claimant never owns the lock, so it never removes the holder's file.
 */
export const acquireRunLock = (
	outputDir: string
): Effect.Effect<
	RunLock,
	RunLockHeld | RunLockUnavailable,
	FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
	Effect.gen(function* step1() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const lockPath = path.join(outputDir, runLockFileName)
		const temps = yield* Ref.make<readonly string[]>([])
		const release = Effect.gen(function* step2() {
			for (const temp of yield* Ref.get(temps)) {
				yield* Effect.ignore(fs.remove(temp, { force: true }))
			}
			yield* Effect.ignore(fs.remove(lockPath, { force: true }))
		})
		yield* Effect.acquireRelease(
			fs
				.writeFileString(lockPath, "", { flag: "wx" })
				.pipe(
					Effect.mapError((cause) =>
						alreadyExists(cause)
							? RunLockHeld.make({ lockPath })
							: RunLockUnavailable.make({ cause, lockPath })
					)
				),
			() => release
		)

		return {
			lockPath,
			registerTemp: (temp: string) => Ref.update(temps, (all) => [...all, temp])
		}
	})
