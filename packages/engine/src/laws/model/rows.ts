import { heapTupleHeaderBytes } from "#compiler/core/page.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { alignUp, bitsPerByte, maxAlign } from "#compiler/schema/representability.ts"
import { datumBound, isFixedWidth } from "#compiler/schema/representability.ts"

/**
 * A TOAST pointer, TOAST_POINTER_SIZE: the in-line bytes a variable-length column's value moved out of line keeps in
 * its row, whatever the value's size, so the least a varlena column can cost a row.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the in-line pointer of one variable-length value stored out of line
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/storage.sgml#L436-L437
 * @quote the total size of an on-disk TOAST pointer datum is therefore 18 bytes regardless of the actual size of the
 *   represented value
 * @verified 2026-11-20
 */
const toastPointerBytes = 18

/**
 * A heap row's size, as PostgreSQL stores it, for the one bound every relation's columns must fit: a row of its table
 * must fit one heap tuple, MaxHeapTupleSize, and a fixed-width column is never moved out of line, so a relation whose
 * fields and law columns together can exceed it holds rows PostgreSQL cannot store.
 */

/**
 * One column of a row as its storage costs it at most once every variable-length value that can be is moved out of
 * line: a fixed-width type at its typlen and alignment; a variable-length one at its least in-line size, the smaller of
 * its longest datum and a TOAST pointer, unaligned, since both are held under a one-byte header. `nullable` marks a
 * column that may hold NULL, a generated law column outside its guard, which gives the row a null bitmap.
 */
export interface RowColumn {
	readonly bytes: number
	readonly align: number
	readonly nullable: boolean
}

/** A column of the descriptor `desc` as a row stores it at most (`RowColumn`). */
export const rowColumn = (desc: FieldDesc, nullable: boolean): RowColumn => {
	const bound = datumBound(desc)
	if (bound === undefined) {
		return { bytes: toastPointerBytes, align: 1, nullable }
	}
	return isFixedWidth(bound)
		? { bytes: bound.bytes, align: bound.align, nullable }
		: { bytes: Math.min(bound.bytes, toastPointerBytes), align: 1, nullable }
}

/**
 * The most bytes a row of these columns takes once every variable-length value that can be is moved out of line: its
 * header, SizeofHeapTupleHeader and a null bitmap of one bit per column when any column may be NULL, rounded up to the
 * greatest alignment (t_hoff); then each column at its alignment, widest alignment first, as the installation orders a
 * table's columns, so no narrower column pads a wider one.
 */
export const rowBytes = (columns: ReadonlyArray<RowColumn>): number => {
	const bitmap = columns.some((c) => c.nullable) ? Math.ceil(columns.length / bitsPerByte) : 0
	const header = alignUp(heapTupleHeaderBytes + bitmap, maxAlign)
	return columns
		.toSorted((a, b) => b.align - a.align)
		.reduce((offset, c) => alignUp(offset, c.align) + c.bytes, header)
}

/**
 * The refusal of a relation whose rows can exceed `limit` bytes, MaxHeapTupleSize in the law model: its fields and every
 * law column on it, each NULL-able one held, take `rowBytes` of them; undefined for one whose every row fits.
 */
export const wideRow = (
	relation: string,
	columns: ReadonlyArray<RowColumn>,
	limit: number
): string | undefined => {
	const bytes = rowBytes(columns)
	return bytes > limit
		? `a relation whose fields and law columns fit one heap tuple of ${limit} bytes (MaxHeapTupleSize), every fixed-width column held inline; a row of ${relation} can take ${bytes}: carry fewer copies or selections on it, or move fields to a relation of their own`
		: undefined
}
