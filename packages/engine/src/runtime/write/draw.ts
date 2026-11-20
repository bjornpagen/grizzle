/**
 * A nested write's rows, as the columnar transport carries them.
 *
 * The caller writes rows; a family is a law over them, and grizzle owns every value a family draws: each count, index,
 * interval, copy and accumulator. So every row a nested write sends is whole: its key, then every other column the host
 * writes, in its relation's row layout (write/family/statements.ts rowLayout), whichever families it is a member of.
 * None of those values is the caller's, so no write can state a gap, a shared slot, a count that disagrees with its
 * family or a fold that disagrees with its members.
 */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ParamText } from "#compiler/core/wire.ts"
import type { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"

/** A member by its relation's primary key: each key field's text, in key order. */
export type MemberKey = NonEmptyReadonlyArray<ParamText>

/**
 * One column of a row as the transport carries it: its parameter text, or a bytes column's admitted value, which travels
 * in its column's binary bytea[] (codec/bytea.ts), since no text carries a bytes value at its own size.
 */
export type MemberCell = ParamText | AdmittedBytes
