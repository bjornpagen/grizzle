import type {
	ChangeSetConstructor,
	ChangeSet as ChangeSetOf
} from "#compiler/types/changeset/changeset.ts"
import { ChangeSet as changeSets } from "#compiler/write/changeset/value.ts"

/**
 * Public barrel: ChangeSet, Delta, outcomes, witnesses and the laws an outcome names. packages/grizzle/src/index.ts
 * re-exports it.
 *
 * ChangeSet is the sealed canonical value of packages/engine/src/write/changeset, built under its public signature
 * (types/changeset ChangeSetConstructor): the runtime records the Description and the inputs and holds the builders'
 * brand and the decoder of its read-backs (reads), and the phantoms (params, paramsInvariant, writes and schema as an
 * invariant function) are optional members under core/phantom.ts's key, which no runtime value holds. The value and
 * the type share the name. WriteListOf and RefreshListOf, a role's lists, are the schema barrel's; Compiled and
 * ApplyOutcome, what db.compile and db.apply return, are the shell's (packages/grizzle/src/adapter/public/db.ts).
 */
export const ChangeSet: ChangeSetConstructor = changeSets
export type ChangeSet<
	S,
	Params = unknown,
	Writes extends string = never,
	Reads = unknown
> = ChangeSetOf<S, Params, Writes, Reads>

export type {
	Addition,
	AnyChangeSet,
	Delta,
	DeltaSource,
	KeyHost,
	Law,
	LawBounds,
	LawSide,
	LawValue,
	LawWeight,
	Member,
	Witness,
	WritableOf
} from "#compiler/types/changeset/changeset.ts"
