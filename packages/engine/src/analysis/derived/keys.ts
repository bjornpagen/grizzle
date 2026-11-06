import type { KeyFault } from "#compiler/core/causes.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { InferredFieldDesc } from "#compiler/ir/desc.ts"
import type { DeclaredKey } from "#compiler/ir/rel.ts"
import { btreeEntry, keyColumns, keyDatums } from "#compiler/schema/representability.ts"

export interface DerivedKeyLayout {
	readonly fields: DeclaredKey
	/** The largest B-tree entry the key's unique index can hold. */
	readonly btreeBytes: number
}

/** A column of a derived relation's heading as a key's layout reads it: its name and its inferred field descriptor. */
interface KeyColumn {
	readonly name: string
	readonly desc: InferredFieldDesc
}

/**
 * The B-tree layout of one inherited key, or why its unique index entry is unrepresentable.
 *
 * The representability of a derived relation's inherited keys.
 *
 * Each inherited key becomes one `CREATE UNIQUE INDEX` over plain columns with no predicate, the index `REFRESH
 * MATERIALIZED VIEW CONCURRENTLY` requires. That index is a B-tree whatever the key's types: a span field
 * is one more ordered datum of an int4range or int8range B-tree, never a WITHOUT OVERLAPS constraint, since uniqueness
 * of a derived relation's facts is equality, not nonoverlap. So a key passes exactly the B-tree half of the check every
 * declared key passes (schema/representability.ts): at most INDEX_MAX_KEYS columns, and a possible entry, the 8-byte
 * tuple header plus each datum at its exact offset through the key's fixed-width prefix and with its worst-case
 * alignment padding from its first varlena on, the whole MAXALIGNed, within BTMaxItemSize (btreeEntryBytes).
 *
 * A definition proved to hold at most one fact, an aggregate over no group key, proves a key narrower than any heading:
 * every single column. Its one unique index is on its first column in heading order whose entry is representable, so a
 * global total whose first column is wildcard text, or a computed numeric whose entry outgrows BTMaxItemSize, is indexed
 * on a later column, such as its count, and refused only when no column's entry fits.
 *
 * When no key narrower than the heading is proven, the index covers the full heading, which the compiler admits only
 * when the heading passes the same check. A computed numeric, a `sum`'s or a `mean`'s, is bounded by the digits and the
 * scale its definition proves (schema/representability.ts datumBound), like a numeric(p, s); a heading holding wildcard
 * text, or datums whose entry outgrows BTMaxItemSize, has no unique index and is `UnrepresentableKey`, naming the key and
 * the bound that failed.
 * A narrower key that fails is refused the same way: every inherited key is evidence only because its
 * unique index exists ("Derived relation scan").
 */
export const derivedKeyLayout = (
	key: NonEmptyReadonlyArray<KeyColumn>
): Result.Result<DerivedKeyLayout, KeyFault> => {
	/** The rule every key's index entry starts from (schema/representability.ts keyDatums), then its B-tree entry. */
	const datums = keyDatums(key.map((c) => ({ field: c.name, desc: c.desc })))
	if (!datums.ok) {
		return datums
	}
	const btreeBytes = btreeEntry(keyColumns(datums.value))
	if (!btreeBytes.ok) {
		return btreeBytes
	}
	return Result.ok({ fields: mapNonEmpty(key, (c) => c.name), btreeBytes: btreeBytes.value })
}

/**
 * Whether `column` alone is a representable inherited key: the key a definition of at most one fact takes, in heading
 * order (analysis/logical/derived.ts inheritedKeys).
 */
export const oneColumnKeyRepresentable = (column: KeyColumn): boolean =>
	derivedKeyLayout([column]).ok
