import { tupleConverter } from "#compiler/codec/row.ts"
import type { Cell } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type Fact, factOf } from "#compiler/write/insert/rows.ts"
import type { PutResult } from "#compiler/write/put/statement.ts"

type PutRow =
	| { readonly kind: "added"; readonly fact: Fact }
	| { readonly kind: "replaced"; readonly fact: Fact; readonly old: Fact }
	| { readonly kind: "removed"; readonly fact: Fact }

type PutRowConverter = (row: ReadonlyArray<Cell>) => PutRow

/** The converter of the rows of one put statement that updates in place:
 * - an upsert row is a fact the put made present, inserted or updated;
 * - an update row is the new fact the put made present and the old fact it displaced;
 * - a MERGE row is a fact an INSERT or an UPDATE made present, or a fact the absorbed deletion removed.
 * A refusal is never a row: a same-key pair within the input and a unique object's refusal raise. Each field converts
 * through its exact codec, trusting PostgreSQL's output text, a closed id's and a set's by the installation's codes. A
 * MERGE action is one of PostgreSQL's three
 * merge_action() words, INSERT, UPDATE or DELETE. */
export const putRowConverter = (result: PutResult, codes: Codebook): PutRowConverter => {
	if (result.kind === "merge") {
		const convert = tupleConverter(result.columns.slice(1), codes)
		return (row) => {
			const fact = factOf(result.fields, convert(row.slice(1)), result.first - 1)
			return row[result.action] === "DELETE" ? { kind: "removed", fact } : { kind: "added", fact }
		}
	}
	const convert = tupleConverter(result.columns, codes)
	return (row) => {
		const values = convert(row)
		const fact = factOf(result.fields, values, 0)
		return result.kind === "upsert"
			? { kind: "added", fact }
			: { kind: "replaced", fact, old: factOf(result.fields, values, result.old) }
	}
}
