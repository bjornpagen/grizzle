import { Option, Result } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import type { CompileError, Owned } from "#compiler/plan/common.ts"
import type { DeploySnapshot } from "#compiler/plan/migration.ts"

/** Every registered snapshot, by itself. */
const registered = new WeakMap<object, DeploySnapshot>()

/**
 * The snapshots the test installer registers.
 *
 * The snapshot the application knows is the one it commits beside its code, `migrations/<root>/snapshot.json`, which
 * every DbLayer.make takes. The test installer registers each installation's snapshot instead (registerSnapshot), which
 * no public API exposes: a layer given a registered snapshot takes it as registered rather than reading it again. The
 * text form is read as the generator wrote it and refused when its fingerprint is not its content's (snapshot/build.ts
 * readSnapshot), so a hand-edited snapshot is never trusted. The registry is a WeakMap keyed by the snapshot, never on
 * globalThis.
 *
 * The snapshot a DbLayer.make was given, when the test installer registered it.
 */
export const registeredSnapshot = (given: object): Option.Option<DeploySnapshot> =>
	Option.fromUndefinedOr(registered.get(given))

/**
 * The index among the snapshot's levels of the level the opened schema `owned` is, when the snapshot installs it: the
 * level at its own depth has its fingerprint, the owned fingerprint of the schema it tops, which digests every level's
 * content and declared name. None for a schema the snapshot does not install. A process over a lower level holds none of
 * the levels above it, and is served by the snapshot of the installation they stand in.
 */
export const servedLevel = (snapshot: DeploySnapshot, owned: Owned): Option.Option<number> => {
	const index = owned.levels.length - 1
	return snapshot.levels[index]?.fingerprint === owned.fingerprint
		? Option.some(index)
		: Option.none()
}

/**
 * Registers the committed snapshot of an installation: a DeploySnapshot, or the snapshot.json text the generator
 * wrote. The registered snapshot is what a DbLayer.make of any of its logins is given.
 */
export const registerSnapshot = (
	snapshot: DeploySnapshot | string
): Result.Result<DeploySnapshot, CompileError> =>
	Result.map(
		typeof snapshot === "string" ? readSnapshot(snapshot) : Result.succeed(snapshot),
		(s) => {
			registered.set(s, s)
			return s
		}
	)
