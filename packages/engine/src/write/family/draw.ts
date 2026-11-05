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

/** An owner, or a group, by its key's texts, in the order the family's group fields pair with them. */
export type Owner = NonEmptyReadonlyArray<string>

/** A member by its relation's primary key: each key field's text, in key order. */
export type MemberKey = NonEmptyReadonlyArray<string>

/** The texts of a row's columns beside its key, in its relation's row layout. */
export type Member = ReadonlyArray<string>

/** A member relation's row as one statement writes it: its key's texts, then every other column's (`Member`). */
export interface Row {
	readonly key: MemberKey
	readonly columns: Member
}

/**
 * An owner's count, as one statement sets it, with its family's ends: the texts of the owner's end fields, every
 * accumulated field its family's last axis carries (write/family/statements.ts endColumns), set in the same UPDATE, so
 * the owner's last-slot copies change with its count. A family with none has none.
 */
export interface Recount {
	readonly owner: Owner
	readonly count: number
	readonly ends: Member
}

/** A row's texts: its key, then its other columns. */
export const rowTexts = (row: Row): ReadonlyArray<string> => [...row.key, ...row.columns]

/** A deleted row's texts: its key. */
export const keyTexts = (key: MemberKey): ReadonlyArray<string> => key

/** A count's texts: the owner's key, then the count, then its ends. */
export const recountTexts = (row: Recount): ReadonlyArray<string> => [
	...row.owner,
	String(row.count),
	...row.ends
]
