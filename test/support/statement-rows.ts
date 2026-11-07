import { Array as Arr } from "effect"
import { scalarReader } from "#compiler/codec/read.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { outputText } from "#test/support/wire.ts"

/**
 * A statement's rows as the tests that run a statement directly read them.
 *
 * The library reads a statement's texts only through a value's decoder (core/decoder.ts), bound to the statement's
 * layout (adapter/reader/execution.ts). A test that runs a template's statement on its own, outside a reader, reads its
 * rows here instead: each text, PostgreSQL's output, converted by its column type's reader, the library's own trusting
 * conversion (codec/read.ts), a row a record of its heading.
 *
 * A record of host values, keyed by column name, with no prototype.
 */
export type RowRecord = { readonly [column: string]: unknown }

const cell = (row: ReadonlyArray<string>, i: number): string => {
	const text = row[i]
	if (text === undefined) {
		throw new Error(`a row without its cell ${i}`)
	}
	return text
}

/** The record of a row's first heading.length texts: each column's host value, a closed id's read through `codes`. */
export const headingRecord = (
	heading: Heading,
	codes: Codebook
): ((row: ReadonlyArray<string>) => RowRecord) => {
	const converts = Arr.map(heading, (c) => [c.name, scalarReader(c.type, codes).convert] as const)
	return (row) => {
		const out: Record<string, unknown> = { __proto__: null }
		for (const [i, [name, convert]] of converts.entries()) {
			out[name] = convert(outputText(cell(row, i)))
		}
		return Object.freeze(out)
	}
}
