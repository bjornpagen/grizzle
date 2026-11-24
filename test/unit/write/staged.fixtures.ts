/** What the properties of staged.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { defined } from "@bjornpagen/testing/assert"
import { array, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { bindFrame } from "#adapter/wire/batch.ts"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { prepared } from "#compiler/core/prepared.ts"
import type { Param } from "#compiler/core/wire.ts"
import { capabilitySet, type ScalarType } from "#compiler/ir/scalar.ts"
import type { MemberCell } from "#compiler/runtime/write/draw.ts"
import {
	type Execution,
	type NestedCells,
	nestedColumn,
	type NestedPlaceholder,
	type NestedRowBound,
	nestedSource,
	type StagedStatement
} from "#compiler/runtime/write/staged.ts"
import { type Transport, wholeBatching } from "#compiler/runtime/write/transport.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { succeeded } from "#test/support/assert.ts"
import { testSql } from "#test/support/sql.ts"
import { paramText } from "#test/support/wire.ts"

/** How a nested column's array is written: a text column's binary text[], a bytes column's bytea[], a literal's. */
type Kind = "text" | "bytes" | "literal"

/**
 * A case's bound on one Bind message: drawn, or exactly the Bind message of one fill carrying every row, which the
 * inline statement passes by its kept value, and never under the least bound a drawn one has (leastLimit).
 */
type Limit = { readonly kind: "drawn"; readonly bytes: number } | { readonly kind: "one fill" }

/** A case: the nested columns, each row's cell lengths, the text's characters, the kept value and the bound. */
interface Sketch {
	readonly kinds: ReadonlyArray<Kind>
	readonly rows: ReadonlyArray<ReadonlyArray<number>>
	readonly character: string
	readonly kept: number
	readonly limit: Limit
}

/** The least bound a case draws: a Bind message of four parameters and the longest kept value fits it. */
const leastLimit = bindFrame.statement + 4 * bindFrame.parameter + 40

const limitGen: Gen<Limit> = weighted<Limit>([
	[7, (source) => ({ kind: "drawn", bytes: source.draw(int(leastLimit, 1_600)) })],
	[1, constant({ kind: "one fill" })]
])

const kindGen: Gen<Kind> = element(["text", "bytes", "literal"] as const)

export const sketchGen: Gen<Sketch> = (source) => {
	const kinds = source.draw(array(kindGen, { min: 1, max: 3 }))
	return {
		kinds,
		rows: source.draw(array((s) => Arr.map(kinds, () => s.draw(int(0, 120))), { min: 0, max: 12 })),
		character: source.draw(element(["a", "é", "€", "𝄞", '"', ",", "\\"] as const)),
		kept: source.draw(int(0, 40)),
		limit: source.draw(limitGen)
	}
}

export type Feature =
	| "inline"
	| "staged in one fill"
	| "staged in several fills"
	| "a row past one fill alone"
	| "a text column"
	| "a bytes column"
	| "a literal column"

const typeOf = (kind: Kind): ScalarType => {
	switch (kind) {
		case "text":
			return wildcardText
		case "bytes":
			return { carrier: "bytes", caps: capabilitySet([]), contract: undefined }
		case "literal":
			return plainType("int4")
	}
}

const cellOf = (kind: Kind, character: string, length: number): MemberCell => {
	switch (kind) {
		case "text":
		case "literal":
			return paramText(Str.repeat(length)(character))
		case "bytes":
			return new AdmittedBytes(new Uint8Array(length).fill(length % 251))
	}
}

/** The relation the cases' nested rows are rows of. */
const entryRelation = StoredRelationName("Entry")

/** The texts of the statement the cases stage, each named as a served write's are. */
const stagedTexts = Object.freeze({
	inline: prepared(testSql("inline")),
	empty: prepared(testSql("empty")),
	fill: prepared(testSql("fill")),
	staged: prepared(testSql("staged"))
})

/** The case's nested rows, its statement, its kept value and its transport. */
export const resolved = (sketch: Sketch) => {
	const cells: NestedCells = {
		relation: entryRelation,
		types: Arr.map(sketch.kinds, typeOf),
		rows: Arr.map(sketch.rows, (row) =>
			Arr.map(row, (length, part) =>
				cellOf(defined(sketch.kinds[part], "a kind"), sketch.character, length)
			)
		)
	}
	const width = sketch.kinds.length
	const source = nestedSource(cells)
	const nested: ReadonlyArray<NestedPlaceholder | undefined> = [
		...Arr.map(sketch.kinds, (_, part) => ({ part, source })),
		undefined
	]
	const columns = Arr.map(sketch.kinds, (_, part) => part)
	const [firstColumn, ...restColumns] = columns
	const statement: StagedStatement = {
		text: stagedTexts.inline,
		staged: {
			kind: "carriers",
			carriers: [
				{
					empty: stagedTexts.empty,
					fill: stagedTexts.fill,
					columns: [defined(firstColumn, "a nested column"), ...restColumns]
				}
			],
			sql: stagedTexts.staged,
			kept: [width]
		},
		nested
	}
	const value = paramText(Str.repeat(sketch.kept)("k"))
	const transport: Transport = {
		messageBytes:
			sketch.limit.kind === "drawn"
				? sketch.limit.bytes
				: Math.max(
						leastLimit,
						bindOf(
							Arr.map(cells.types, (_, part) =>
								succeeded(nestedColumn(cells, part, cells.rows), "a column encodes")
							)
						)
					),
		literalUnits: maxStringLength,
		frame: bindFrame,
		batching: wholeBatching
	}
	return { cells, statement, value, transport, width }
}

type Resolved = ReturnType<typeof resolved>

/** A Bind message's length as the wire counts it: its fields, and each parameter's format, length and bytes. */
export const bindOf = (params: ReadonlyArray<Param>): number =>
	Arr.reduce(
		params,
		bindFrame.statement,
		(sum, p) => sum + bindFrame.parameter + (typeof p === "string" ? utf8Length(p) : p.byteLength)
	)

/** Each nested column's array over `rows`, written by its encoder. */
const written = (r: Resolved, rows: NestedCells["rows"]): ReadonlyArray<Param> =>
	Arr.map(r.cells.types, (_, part) =>
		succeeded(nestedColumn(r.cells, part, rows), "a column encodes")
	)

/** The executions the encoders' own sizes give (the header's oracle), or the bound of the first row no fill carries. */
export const expected = (r: Resolved): Result.Result<ReadonlyArray<Execution>, NestedRowBound> => {
	const all = r.cells.rows
	const inline = [...written(r, all), r.value]
	if (bindOf(inline) <= r.transport.messageBytes) {
		return Result.ok([{ text: stagedTexts.inline, params: inline, part: "statement" }])
	}
	const out: Array<Execution> = [{ text: stagedTexts.empty, params: [], part: "empty" }]
	let from = 0
	while (from < all.length) {
		const alone = bindOf(written(r, all.slice(from, from + 1)))
		if (alone > r.transport.messageBytes) {
			return Result.err({
				_tag: "NestedRowBound",
				relation: entryRelation,
				row: { kind: "message", bytes: alone, limit: r.transport.messageBytes }
			})
		}
		let to = from + 1
		while (
			to < all.length &&
			bindOf(written(r, all.slice(from, to + 1))) <= r.transport.messageBytes
		) {
			to += 1
		}
		out.push({
			text: stagedTexts.fill,
			params: written(r, all.slice(from, to)),
			part: "fill"
		})
		from = to
	}
	out.push({ text: stagedTexts.staged, params: [r.value], part: "statement" })
	return Result.ok(out)
}
