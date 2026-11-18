/**
 * A nested write's rows, as the columnar transport carries them.
 *
 * The caller writes rows; a family is a law over them, and grizzle owns every value a family draws: each count, index,
 * interval, copy and accumulator. So every row a nested write sends is whole: its key, then every other column the host
 * writes, in its relation's row layout (write/family/statements.ts rowLayout), whichever families it is a member of.
 * None of those values is the caller's, so no write can state a gap, a shared slot, a count that disagrees with its
 * family or a fold that disagrees with its members.
 */
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"

/** An owner, or a group, by its key's texts, in the order the family's group fields pair with them. */
export type Owner = NonEmptyReadonlyArray<ParamText>

/** A member by its relation's primary key: each key field's text, in key order. */
export type MemberKey = NonEmptyReadonlyArray<ParamText>

/**
 * One column of a row as the transport carries it: its parameter text, or a bytes column's admitted value, which travels
 * in its column's binary bytea[] (codec/bytea.ts), since no text carries a bytes value at its own size.
 */
export type MemberCell = ParamText | AdmittedBytes

/** The cells of a row's columns beside its key, in its relation's row layout. */
export type Member = ReadonlyArray<MemberCell>

/** A member relation's row as one statement writes it: its key's texts, then every other column's cell (`Member`). */
export interface Row {
	readonly key: MemberKey
	readonly columns: Member
}

/** A row's cells: its key's texts, then its other columns'. */
export const rowTexts = (row: Row): ReadonlyArray<MemberCell> => [...row.key, ...row.columns]
