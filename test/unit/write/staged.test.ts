/**
 * A statement's nested rows past one Bind message (write/program/staged.ts executionsOf): the statement goes inline
 * while its Bind message, every array of its nested rows written whole, fits the transport, and otherwise its carriers
 * are created, filled chunk by chunk, analyzed, and the staged statement sent, each fill as long as one Bind message
 * carries. The cut is measured from the cells' lengths, none of an array written to measure it.
 *
 * Over drawn nested rows of text, bytes and literal columns, of drawn lengths, beside a placeholder the staged
 * statement keeps, under a drawn message bound:
 *
 * - **The executions are the encoders' own** (oracle: a second implementation, the cut by real encodings): the inline
 *   statement, its arrays written whole by the column's encoder, exactly where their Bind message, as the wire counts
 *   it, fits the bound; otherwise the carrier's creation, then fills of the longest runs of rows whose arrays, written
 *   by the same encoders, fit one Bind message, in row order, then the ANALYZE and the staged statement with the kept
 *   placeholder's value; a row whose fill alone is past the bound refuses the write as that row's NestedRowBound. So
 *   every execution's Bind message fits the bound, every row travels exactly once, in order, and no fill could have
 *   carried the next row too.
 *
 * Kept: rows past one Bind message in several fills.
 *
 * Planted: a statement with no staged form (`staged` none) sends its rows inline past the bound, and the search fails
 * on the kept case past it, which the second test requires.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { bindFrame } from "#adapter/wire/batch.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { Param } from "#compiler/core/wire.ts"
import { capabilitySet, type ScalarType } from "#compiler/ir/scalar.ts"
import type { MemberCell } from "#compiler/runtime/write/draw.ts"
import {
	type Execution,
	executionsOf,
	type NestedCells,
	nestedColumn,
	type NestedPlaceholder,
	type NestedRowBound,
	type StagedStatement
} from "#compiler/runtime/write/staged.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { paramText } from "#test/support/wire.ts"

/** How a nested column's array is written: a text column's binary text[], a bytes column's bytea[], a literal's. */
type Kind = "text" | "bytes" | "literal"

/** A case: the nested columns, each row's cell lengths, the text's characters, the kept value and the bound. */
interface Sketch {
	readonly kinds: ReadonlyArray<Kind>
	readonly rows: ReadonlyArray<ReadonlyArray<number>>
	readonly character: string
	readonly kept: number
	readonly limit: number
}

const kindGen: Gen<Kind> = element(["text", "bytes", "literal"] as const)

const sketchGen: Gen<Sketch> = (source) => {
	const kinds = source.draw(array(kindGen, { min: 1, max: 3 }))
	return {
		kinds,
		rows: source.draw(array((s) => Arr.map(kinds, () => s.draw(int(0, 120))), { min: 0, max: 12 })),
		character: source.draw(element(["a", "é", "€", "𝄞", '"', ",", "\\"] as const)),
		kept: source.draw(int(0, 40)),
		limit: source.draw(int(bindFrame.statement + 4 * bindFrame.parameter + 40, 1_600))
	}
}

type Feature =
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
			return { carrier: "bytes", caps: capabilitySet([]) }
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

/** The case's nested rows, its statement, its kept value and its transport. */
const resolved = (sketch: Sketch) => {
	const cells: NestedCells = {
		relation: "Entry",
		types: Arr.map(sketch.kinds, typeOf),
		rows: Arr.map(sketch.rows, (row) =>
			Arr.map(row, (length, part) =>
				cellOf(defined(sketch.kinds[part], "a kind"), sketch.character, length)
			)
		)
	}
	const width = sketch.kinds.length
	const nested: ReadonlyArray<NestedPlaceholder | undefined> = [
		...Arr.map(sketch.kinds, (_, part) => ({ part, cells })),
		undefined
	]
	const columns = Arr.map(sketch.kinds, (_, part) => part)
	const [firstColumn, ...restColumns] = columns
	const statement: StagedStatement = {
		sql: testSql("inline"),
		staged: {
			kind: "carriers",
			carriers: [
				{
					create: testSql("create"),
					fill: testSql("fill"),
					columns: [defined(firstColumn, "a nested column"), ...restColumns]
				}
			],
			analyze: testSql("analyze"),
			sql: testSql("staged"),
			kept: [width]
		},
		nested
	}
	const value = paramText(Str.repeat(sketch.kept)("k"))
	const transport: Transport = {
		messageBytes: sketch.limit,
		literalUnits: maxStringLength.value,
		frame: bindFrame
	}
	return { cells, statement, value, transport, width }
}

type Resolved = ReturnType<typeof resolved>

/** A Bind message's length as the wire counts it: its fields, and each parameter's format, length and bytes. */
const bindOf = (params: ReadonlyArray<Param>): number =>
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
const expected = (r: Resolved): Result.Result<ReadonlyArray<Execution>, NestedRowBound> => {
	const all = r.cells.rows
	const inline = [...written(r, all), r.value]
	if (bindOf(inline) <= r.transport.messageBytes) {
		return Result.ok([{ sql: testSql("inline"), params: inline, part: "statement" }])
	}
	const out: Array<Execution> = [{ sql: testSql("create"), params: [], part: "create" }]
	let from = 0
	while (from < all.length) {
		const alone = bindOf(written(r, all.slice(from, from + 1)))
		if (alone > r.transport.messageBytes) {
			return Result.err({
				_tag: "NestedRowBound",
				relation: "Entry",
				row: { kind: "message", bytes: alone, limit: r.transport.messageBytes, statement: "insert" }
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
			sql: testSql("fill"),
			params: written(r, all.slice(from, to)),
			part: "fill"
		})
		from = to
	}
	out.push({ sql: testSql("analyze"), params: [], part: "analyze" })
	out.push({ sql: testSql("staged"), params: [r.value], part: "statement" })
	return Result.ok(out)
}

/** How a statement reaches executionsOf: as it is compiled, or with its staged form planted away. */
type Staging = (statement: StagedStatement) => StagedStatement

const asCompiled: Staging = (statement) => statement

/** The planted bug: a statement whose staged form is gone, which sends its rows inline past any bound. */
const unstaged: Staging = (statement) => ({ ...statement, staged: { kind: "none" } })

/** The header's property, over the executions of each case's statement as `staging` hands it over. */
const property = (staging: Staging) => (sketch: Sketch, c: Case<Feature>) =>
	Effect.sync(() => {
		const r = resolved(sketch)
		for (const kind of sketch.kinds) {
			c.note(
				kind === "text" ? "a text column" : kind === "bytes" ? "a bytes column" : "a literal column"
			)
		}
		const got = executionsOf(
			staging(r.statement),
			"statement",
			(position) => {
				assert.equal(position, r.width, "only the kept placeholder is encoded by its slot")
				return Result.ok(r.value)
			},
			r.transport
		)
		const want = expected(r)
		if (!want.ok) {
			c.note("a row past one fill alone")
			assert.deepEqual(got, want, "a row no fill carries alone refuses the write")
			return
		}
		const fills = Arr.filter(want.value, (e) => e.part === "fill").length
		c.note(
			want.value.length === 1
				? "inline"
				: fills <= 1
					? "staged in one fill"
					: "staged in several fills"
		)
		assert.deepEqual(got, want, "the executions are the encoders' own cut")
		for (const e of succeeded(got)) {
			assert.ok(
				bindOf(e.params) <= r.transport.messageBytes,
				"every execution's Bind message fits the bound"
			)
		}
	})

/** Rows past one Bind message in several fills, a case the planted bug sends inline past the bound. */
const pastTheBound: Sketch = {
	kinds: ["bytes", "text"],
	rows: [
		[120, 40],
		[120, 40],
		[120, 40],
		[120, 40]
	],
	character: "a",
	kept: 0,
	limit: 400
}

describe("nested rows past one Bind message", () => {
	it.effect(
		"go inline where they fit and otherwise through a carrier filled in the longest chunks one Bind carries",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/staged",
						draw: drawn(sketchGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the inline statement or the greedy cut by the encoders' own arrays"
						},
						coverage: required<Feature>(
							[
								"inline",
								"staged in one fill",
								"staged in several fills",
								"a row past one fill alone",
								"a text column",
								"a bytes column",
								"a literal column"
							],
							{ cases: 64, sense: notesOnly }
						),
						kept: [
							{
								note: "rows past one Bind message in several fills",
								sketch: pastTheBound,
								draws: "",
								reaches: ["staged in several fills", "a bytes column", "a text column"]
							}
						],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					property(asCompiled)
				)
			)
	)

	it.effect(
		"fails, planted with no staged form, on a statement whose rows are past the bound",
		(ctx) =>
			Effect.gen(function* () {
				const failure = yield* Effect.flip(
					searched(
						ctx,
						explore(
							{
								suite: "unit/write/staged, planted",
								draw: drawn(sketchGen),
								literal: Formatter.format,
								oracle: {
									kind: "second-implementation",
									name: "the inline statement or the greedy cut by the encoders' own arrays"
								},
								coverage: noCoverage,
								kept: [
									{
										note: "rows past one Bind message, which the planted bug sends inline",
										sketch: pastTheBound,
										draws: "",
										reaches: ["staged in several fills"]
									}
								],
								runs: 8,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 4,
								caseHang
							},
							property(unstaged)
						)
					)
				)
				assert.equal(failure._tag, "PropertyFalsified", "the search catches the planted bug")
			})
	)
})
