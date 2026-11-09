import { Option } from "effect"
import type { Owned } from "#compiler/plan/common.ts"
import type { DeploySnapshot } from "#compiler/plan/migration.ts"

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
