import { tupleConverter } from "#compiler/codec/row.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type Fact, factOf } from "#compiler/runtime/write/rows.ts"
import type { PutResult } from "#compiler/write/put/statement.ts"

type PutRow =
	| { readonly kind: "added"; readonly fact: Fact }
	| { readonly kind: "replaced"; readonly fact: Fact; readonly old: Fact }

type PutRowConverter = (row: ReadonlyArray<OutputText>) => PutRow

/** The converter of the rows of one put statement that updates in place:
 * - an upsert row is a fact the put made present, inserted or updated;
 * - an update row is the new fact the put made present and the old fact it displaced.
 * A refusal is never a row: a same-key pair within the input and a unique object's refusal raise. Each field converts
 * through its exact codec, trusting PostgreSQL's output text, a closed id's and a set's by the installation's codes. */
export const putRowConverter = (result: PutResult, codes: Codebook): PutRowConverter => {
	const convert = tupleConverter(result.columns, codes)
	return (row) => {
		const values = convert(row)
		const fact = factOf(result.fields, values, 0)
		return result.kind === "upsert"
			? { kind: "added", fact }
			: { kind: "replaced", fact, old: factOf(result.fields, values, result.old) }
	}
}
