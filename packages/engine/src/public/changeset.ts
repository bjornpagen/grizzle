import { sameContent } from "#compiler/core/canonical.ts"
import type { ChangeSetConstructor, ChangeSetOf, Law } from "#compiler/types/changeset/changeset.ts"
import { changeSets } from "#compiler/write/changeset/value.ts"

/**
 * Public barrel: ChangeSet, Delta, the rows a caller writes (Addition, AdditionIn), outcomes, witnesses, the laws an
 * outcome names, what an insertion preview reads and gives (InsertAllRowsOf, InsertPreview, PreviewRows and the
 * PreviewRefusal arms), and what a facts decoder gives (FactsDecoder, FactsRefused and RowPlace), whose functions,
 * insertPreview and factsDecoder, are the shell's (packages/grizzle/src/adapter/public/host.ts).
 * packages/grizzle/src/index.ts re-exports it.
 *
 * ChangeSet is the sealed canonical value of packages/engine/src/write/changeset, built under its public signature
 * (types/changeset ChangeSetConstructor): the runtime records the Description and the inputs and holds the builders'
 * brand and the decoder of its read-backs (reads), and the phantoms (params, paramsInvariant, writes and schema as an
 * invariant function) are optional members under core/phantom.ts's key, which no runtime value holds. The value and
 * the type share the name, and this module alone gives it: the value is write/changeset/value.ts changeSets, the type
 * types/changeset ChangeSetOf over S, Params, Writes and Reads. WriteListOf, a role's write list, is the schema
 * barrel's; Compiled and ApplyOutcome, what db.compile and db.apply return, are the shell's
 * (packages/grizzle/src/adapter/public/db.ts).
 */
export const ChangeSet: ChangeSetConstructor = changeSets
export type ChangeSet<
	S,
	Params = unknown,
	Writes extends string = never,
	Reads = unknown
> = ChangeSetOf<S, Params, Writes, Reads>

export type {
	AboveLaw,
	AboveRefusedLaw,
	Addition,
	AdditionIn,
	AnyChangeSet,
	Delta,
	DeltaSource,
	IdentifiedLaw,
	InsertableNameOf,
	InsertAllRowsOf,
	KeyHost,
	Law,
	LawEntry,
	LawSide,
	Member,
	OwnLaw,
	BrokenLaws,
	DrawnBy,
	RefusedLaw,
	RefusingObject,
	StatedLaw,
	Witness,
	WritableOf
} from "#compiler/types/changeset/changeset.ts"
export type { GeneratedLawId, LawId } from "#compiler/core/ids.ts"
export type { FactsDecoder, FactsRefused, RowPlace } from "#compiler/types/changeset/decode.ts"
export type {
	InsertPreview,
	PreviewRefusal,
	PreviewRows
} from "#compiler/types/changeset/preview.ts"

/**
 * sameLaw(a, b): whether two laws, as an `invariant-rejected` outcome or lawsOf names them, are one law of a schema:
 * their descriptions are canonically equal, as the engine compares owned values, source locations aside
 * (core/canonical.ts sameContent). A schema's two laws are described alike exactly when they are one law.
 */
export const sameLaw = (a: Law, b: Law): boolean => sameContent(a, b)
