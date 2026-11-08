/**
 * A family write's rows, as the columnar transport carries them (rows-first.md §1).
 *
 * The caller writes rows; a family is a law over them, and grizzle owns every value a family draws: each count, index,
 * interval, copy and accumulator. So every row a family write sends is whole: its key, then every other column the host
 * writes, in its relation's row layout (write/family/statements.ts rowColumns), whichever families it is a member of,
 * and every owner's count statement carries its count and its ends. None of those values is the caller's, so no write
 * can state a gap, a shared slot, a count that disagrees with its family or a fold that disagrees with its members.
 */
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { Bytes } from "#compiler/scalar/values/bytes.ts"

/** An owner, or a group, by its key's texts, in the order the family's group fields pair with them. */
export type Owner = NonEmptyReadonlyArray<ParamText>

/** A member by its relation's primary key: each key field's text, in key order. */
export type MemberKey = NonEmptyReadonlyArray<ParamText>

/**
 * One column of a row as the transport carries it: its parameter text, or a bytes column's value, which travels in its
 * column's binary bytea[] (codec/bytea.ts), since no text carries a bytes value at its own size.
 */
export type MemberCell = ParamText | Bytes

/** The cells of a row's columns beside its key, in its relation's row layout. */
export type Member = ReadonlyArray<MemberCell>

/** A member relation's row as one statement writes it: its key's texts, then every other column's cell (`Member`). */
export interface Row {
	readonly key: MemberKey
	readonly columns: Member
}

/**
 * An owner's count as its family's fill draws it, with its family's ends: the host value of each of the owner's end
 * fields by name, every accumulated field its family's last axis carries (write/family/statements.ts endColumns),
 * which its count statement sets in the same UPDATE, so the owner's last-slot copies change with its count. A family
 * with none has none. Its values are host values, never texts: the count statement's texts are written once, at the
 * statement (`CountRow`), and no text of them is read back.
 */
export interface Recount {
	readonly owner: Owner
	readonly count: number
	readonly ends: ReadonlyMap<string, unknown>
}

/** An owner's count statement row, as the transport carries it: its key's texts, then its count's and its ends'. */
export interface CountRow {
	readonly owner: Owner
	readonly drawn: ReadonlyArray<ParamText>
}

/** A row's cells: its key's texts, then its other columns'. */
export const rowTexts = (row: Row): ReadonlyArray<MemberCell> => [...row.key, ...row.columns]

/** A deleted row's texts: its key. */
export const keyTexts = (key: MemberKey): ReadonlyArray<ParamText> => key

/** A count statement row's texts: the owner's key, then its count and its ends. */
export const countTexts = (row: CountRow): ReadonlyArray<ParamText> => [...row.owner, ...row.drawn]
