import { Array as Arr } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { defined } from "#test/support/assert.ts"
import { type Nested, showValue } from "#test/support/oracle/public/answer.ts"
import type { ParentColumn, Query, Root } from "#test/support/oracle/public/program.ts"
import { valueKey } from "#test/support/oracle/reference/values.ts"

/**
 * How the suite reads the adapter's delivered rows and their texts, and the planted defects that prove it can fail.
 *
 * The suite reads every public answer as delivered. Its planted-bug check (planted.test.ts) reads them through
 * `bySpelling` instead, a test double of a stitch by text: the attachment statement keeps one spelling of
 * natively equal parent keys (its DISTINCT), and the host gives the children only to the parents whose key prints as
 * that spelling, so a parent whose key is equal but spelled otherwise gets none. The suite must fail on it, which shows
 * that its population reaches two spellings of one parent key with children and that its comparison is exact per
 * parent. A run writes nothing to the tree: the suite's required features hold that reach on every run, and the
 * report prints the shrunk sketch, which a fix promotes into the suite's kept sketches.
 *
 * The suite also reads every cell text its perturbed reader converts strictly (cells.ts), and requires a `Conversion`
 * of the text to agree: the library's own, `asConverted`. Its second planted-bug check passes `boolByF` instead, a
 * trusting boolean conversion that reads only `f` as true: the outermost SELECT writes a boolean as true or false, so
 * every true cell converts to false, and the suite must fail on the first case that delivers one.
 *
 * A reading of delivered rows.
 */
export type Stitch = (rows: ReadonlyArray<Nested>, query: Root) => ReadonlyArray<Nested>

export const asDelivered: (rows: ReadonlyArray<Nested>, query: Root) => ReadonlyArray<Nested> = (
	rows: ReadonlyArray<Nested>
): ReadonlyArray<Nested> => rows

/** The parent columns a child binds, by position in the parent's heading. */
const keyPositions = (
	q: Query<ParentColumn>,
	child: Query<ParentColumn>
): ReadonlyArray<number> => {
	const names = new Set(
		Arr.flatMap(child.arms[0].matches, (m) =>
			Arr.flatMap(m.bindings, (b) => (b.operand.kind === "parent" ? [b.operand.column.name] : []))
		)
	)
	return Arr.flatMap(q.heading, (c, i) => (names.has(c.name) ? [i] : []))
}

const restitch = (q: Query<ParentColumn>, rows: ReadonlyArray<Nested>): ReadonlyArray<Nested> => {
	let current = rows
	for (const [a, attachment] of q.attachments.entries()) {
		const positions = keyPositions(q, attachment.child)
		const identity = (row: Nested) =>
			Arr.join(
				Arr.map(positions, (i) =>
					valueKey(
						defined(row.values[i], `the parent value ${i}`),
						defined(q.heading[i], `the column ${i}`).type
					)
				),
				"\u0000"
			)
		const spelling = (row: Nested) =>
			Arr.join(
				Arr.map(positions, (i) => showValue(defined(row.values[i], `the parent value ${i}`))),
				"\u0000"
			)
		const kept = new Map<
			string,
			{ readonly spelling: string; readonly children: ReadonlyArray<Nested> }
		>()
		for (const row of Arr.dedupeWith(current, (x, y) => identity(x) === identity(y))) {
			kept.set(identity(row), { spelling: spelling(row), children: row.attachments[a] ?? [] })
		}
		current = Arr.map(current, (row) => {
			const group = kept.get(identity(row))
			const children = group !== undefined && group.spelling === spelling(row) ? group.children : []
			return {
				values: row.values,
				attachments: Arr.map(row.attachments, (list, i) =>
					i === a ? restitch(attachment.child, children) : list
				)
			}
		})
	}
	return current
}

/** A stitch by text as a test double: children stitched by the spelling of their parent's key. */
export const bySpelling = (rows: ReadonlyArray<Nested>, query: Root): ReadonlyArray<Nested> =>
	restitch(query, rows)

/** A trusting conversion of a column type's output text into its host value. */
export type Conversion = (type: ScalarType) => (text: string) => unknown

/** The library's conversion (packages/engine/src/scalar/values/convert.ts). */
export const asConverted: Conversion = (type) => scalarCodec(type).convert

/** A boolean conversion that misreads every text but `f`: true where PostgreSQL wrote false, and false for true. */
export const boolByF: Conversion = (type) =>
	type.carrier === "bool" ? (text) => text === "f" : scalarCodec(type).convert
