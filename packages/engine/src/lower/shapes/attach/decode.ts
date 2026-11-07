import { jsonStrings } from "#compiler/core/json-strings.ts"
import type { Heading, HeadingColumn, NodeOf } from "#compiler/ir/rel.ts"

/** The index of `search` in `text` at or after `from`, or undefined when it does not occur there. */
const indexFrom = (text: string, search: string, from: number): number | undefined => {
	const i = text.indexOf(search, from)
	return i < 0 ? undefined : i
}

/** The quoted element whose opening quote is at `open`, unescaped, and the index past its closing quote. */
const quotedElement = (
	text: string,
	open: number
): { readonly value: string; readonly next: number } => {
	let value = ""
	let start = open + 1
	for (;;) {
		/** Read without a check, as every element is: array_out closes each quoted element before the closing brace. */
		const quote = indexFrom(text, '"', start) ?? text.length - 1
		const backslash = indexFrom(text, "\\", start)
		if (backslash === undefined || backslash > quote) {
			return { value: value + text.slice(start, quote), next: quote + 1 }
		}
		value += text.slice(start, backslash) + text.slice(backslash + 1, backslash + 2)
		start = backslash + 2
	}
}

/**
 * The elements of a one-dimensional array's text output (array_out), read without a check: `{}` when empty, elements
 * separated by commas, an element double-quoted when it is empty, holds a delimiter, brace, quote, backslash or
 * whitespace, or spells NULL, with `\"` and `\\` escaped inside quotes. A fused attachment's array holds no NULL element,
 * so an unquoted element is its own text. The strict reading lives in the test kernel (test/support/kernel/strict.ts).
 */
export const arrayElements = (text: string): ReadonlyArray<string> => {
	const out: Array<string> = []
	const end = text.length - 1
	let i = 1
	while (i < end) {
		if (text.charCodeAt(i) === 0x22) {
			const quoted = quotedElement(text, i)
			out.push(quoted.value)
			i = quoted.next
		} else {
			/** The last element runs to the closing brace. */
			const stop = indexFrom(text, ",", i) ?? end
			out.push(text.slice(i, stop))
			i = stop
		}
		i += 1
	}
	return out
}

/**
 * Where a fused child column's text comes from: a field of the array's element, or the parent row's column it is
 * correlated to, of the same type, which the parent row delivers instead: equal values decode to one host value.
 */
export type FusedSource =
	| { readonly from: "element" }
	| { readonly from: "parent"; readonly parent: string }

export interface FusedColumn {
	readonly column: HeadingColumn
	readonly source: FusedSource
}

/**
 * What a fused array carries (attach/index.ts fusedLayout): each child column, in the child heading's order, with
 * where its text comes from. The element carries the element columns in that order; with none, each child is one
 * `true` in the array: its existence.
 */
export interface FusedLayout {
	readonly columns: ReadonlyArray<FusedColumn>
}

/**
 * An attachment fused into its parent statement: one output column named after the attachment, `ARRAY(SELECT ...)` of
 * the one field the array carries per child or `ARRAY(SELECT to_jsonb(c) ...)` of its several, correlated
 * on the parent's columns `parentColumns`. A child with attachments of its own is never fused (check/approximate
 * pipelinedOnly), so a fused attachment has none.
 *
 * The child rows of fused attachments.
 *
 * A fused attachment is one column of its parent's statement: `ARRAY(SELECT ...)`, an empty array rather than NULL
 * for a parent without children. Inside the array every child value is already its exact text form, cast by the
 * subquery itself the way the outermost SELECT casts a result column (money through numeric, codec resultTextCasts),
 * because the outermost cast cannot reach inside an array:
 *
 * - one field: `ARRAY(SELECT c::text ...)`, a text[] whose text output is PostgreSQL's array literal, `{a,"b c"}`;
 * - several fields: `ARRAY(SELECT to_jsonb(ROW(c1::text, c2::text)) ...)`, a jsonb[] whose elements are objects with
 *   the keys f1 to fn in column order, each value a JSON string of the field's text form. JSON is a wire encoding here
 *   exactly as for relation parameters; it is never a fact domain.
 *
 * A child column correlated to a parent column of the same type is not in the array: the parent row delivers it, and
 * its text is copied into each child's texts, which decode to the child's value since equal values have one host form. So a child keyed by its parent
 * and one more field, (task, tag) correlated on task, fuses as the single field tag.
 *
 * The parse reads the column's text into each child's texts, in the child heading's order, a straight loop with no
 * eval and no check: every text is PostgreSQL's own output of grizzle's own subquery, which no admitted lowering makes
 * malformed or fills with a NULL element. The child rows are then decoded, and delivered in the attachment's delivery,
 * by the value's decoder (core/decoder.ts attachment), as a pipelined attachment's are.
 */
export interface FusedAttachment {
	/** The attachment it fuses, whose judged delivered type and correlation the reader reads. */
	readonly attach: NodeOf<"Attach">
	readonly name: string
	readonly parentColumns: ReadonlyArray<string>
	readonly layout: FusedLayout
}

/** The child columns a fused array's element carries, in order. */
export const fusedElement = (layout: FusedLayout): Heading =>
	layout.columns.flatMap((c) => (c.source.from === "element" ? [c.column] : []))

/**
 * The texts of the children of one parent from its fused column's text and the parent row's texts: per element, the
 * child heading's columns in order.
 */
export type FusedTexts = (
	text: string,
	parent: ReadonlyArray<string>
) => ReadonlyArray<ReadonlyArray<string>>

/**
 * The field texts of one element of a jsonb[] fused column, read in order: jsonb_out's text of an object whose values
 * are strings, `{"f1": "a", "f2": "b\"c"}`. jsonb orders an object's keys by length, then bytewise, which for f1 to fn
 * is their numeric order, so the strings alternate key and value, and the i-th value read is field i's.
 */
const objectFields = (text: string): (() => string) => {
	const next = jsonStrings(text)
	return () => {
		next()
		return next()
	}
}

/**
 * The parse of a fused attachment column whose parent row's text of a correlated parent column `parentCell` reads: its
 * array text and the parent row's texts to the children's texts, in the array's order.
 */
export const fusedTexts = (
	layout: FusedLayout,
	parentCell: (column: string) => (row: ReadonlyArray<string>) => string
): FusedTexts => {
	const several = fusedElement(layout).length > 1
	/**
	 * Each child column's text from the parent row and the element's fields, read in the element heading's order: the
	 * text itself for one field, an object's values for several.
	 */
	const cells = layout.columns.map((c) =>
		c.source.from === "element"
			? c.source
			: { from: "parent" as const, read: parentCell(c.source.parent) }
	)
	return (text, parent) =>
		arrayElements(text).map((e) => {
			const field = several ? objectFields(e) : () => e
			return cells.map((cell) => (cell.from === "element" ? field() : cell.read(parent)))
		})
}
