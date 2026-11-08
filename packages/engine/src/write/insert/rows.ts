import { tupleConverter } from "#compiler/codec/row.ts"
import type { Cell } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { DeleteResult, InsertResult } from "#compiler/write/insert/statement.ts"

export type Fact = { readonly [field: string]: unknown }

/** The fact of `fields` read from `values` from position `offset` on: a frozen record without a prototype, so a field
 * named like a member of `Object.prototype` is an own property like any other. */
export const factOf = (
	fields: ReadonlyArray<string>,
	values: ReadonlyArray<unknown>,
	offset: number
): Fact => {
	const out: Record<string, unknown> = { __proto__: null }
	for (const [i, field] of fields.entries()) {
		out[field] = values[offset + i]
	}
	return Object.freeze(out)
}

/** One row of a write statement: `added`, a fact the statement made present (the complete fact, or its key when the
 * statement returns keys only), or `removed`, a fact it made absent. */
type WriteRow =
	| { readonly kind: "added"; readonly fact: Fact }
	| { readonly kind: "removed"; readonly fact: Fact }

type WriteRowConverter = (row: ReadonlyArray<Cell>) => WriteRow

type RowResult = InsertResult | DeleteResult

/** The converter of one write statement's rows. A write statement's result descriptor records its columns, so its text
 * rows convert without reading SQL: every row of an insert is a fact the statement inserted, every row of a deletion a
 * fact it made absent. A refusal is never a row: the statement that detects it raises it, and the runtime classifies
 * the error. Each field converts through its exact codec (`tupleConverter`), trusting PostgreSQL's output text, a
 * closed id's and a set's by the installation's codes. */
export const writeRowConverter = (result: RowResult, codes: Codebook): WriteRowConverter => {
	const convert = tupleConverter(result.columns, codes)
	const fields = result.fields
	const kind = result.kind === "delete" ? "removed" : "added"
	return (row) => ({ kind, fact: factOf(fields, convert(row), 0) })
}
