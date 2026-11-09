/**
 * A family statement's rows ordered by their pattern input (write/family/pattern-order.ts byPatternInput).
 *
 * The oracle is the order's definition, restated over the drawn rows: the result is the rows given, each once; rows of
 * one pattern input, their texts at the positions, are consecutive, so a pattern is compiled once per statement; rows
 * of one input keep the order they came in; and with no input the rows are as they came. A row is its texts, drawn from
 * a three-letter alphabet so rows often share their input, and the positions are any subset of its columns.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, codePoint, type Gen, int, string, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { byPatternInput } from "#compiler/write/family/pattern-order.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

/** A case: rows of one width, each its texts, and the positions of the pattern input among them. */
interface Case {
	readonly rows: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
	readonly positions: ReadonlySet<number>
}

/** A column's text from a three-letter alphabet, so rows often share their pattern input. */
const textGen: Gen<string> = string(codePoint(0x61, 0x63), { min: 0, max: 2 })

const caseGen: Gen<Case> = (source) => {
	const width = source.draw(int(1, 4))
	const columns = upTo(width, (i) => i)
	const rowGen: Gen<ReadonlyArray<string>> = (inner) => Arr.map(columns, () => inner.draw(textGen))
	const first = source.draw(rowGen)
	const rest = source.draw(array(rowGen, { min: 0, max: 11 }))
	return {
		rows: [first, ...rest],
		positions: new Set(source.draw(subset(columns, { min: 0, max: width })))
	}
}

type Feature = "no pattern input" | "rows of one input split apart" | "an input over two columns"

describe("a family statement's rows by their pattern input", () => {
	it.effect(
		"are the rows given, those of one input consecutive and in the order they came",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/pattern-order",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a stable grouping of the rows by their texts at the positions"
						},
						coverage: required<Feature>(
							["no pattern input", "rows of one input split apart", "an input over two columns"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: { kind: "bounded", candidates: 200 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
						Effect.sync(() => {
							const ordered = byPatternInput(k.rows, (row) => row, k.positions)
							/** A row's pattern input: its texts at the positions, in column order. */
							const inputOf = (row: ReadonlyArray<string>): ReadonlyArray<string> =>
								Arr.filter(row, (_, i) => k.positions.has(i))
							const sameInput = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
								const x = inputOf(a)
								const y = inputOf(b)
								return x.length === y.length && Arr.every(x, (text, i) => y[i] === text)
							}
							assert.equal(ordered.length, k.rows.length, "every row once")
							assert.ok(
								Arr.every(k.rows, (row) => Arr.contains(ordered, row)),
								"the rows given, each once"
							)
							if (k.positions.size === 0) {
								c.note("no pattern input")
								assert.deepEqual(ordered, k.rows, "with no input, the rows as they came")
								return
							}
							if (k.positions.size > 1) {
								c.note("an input over two columns")
							}
							for (const [i, row] of ordered.entries()) {
								const later = Arr.drop(ordered, i + 1)
								const next = Arr.findFirstIndex(later, (other) => !sameInput(other, row))
								if (Option.isSome(next)) {
									assert.ok(
										!Arr.some(Arr.drop(later, next.value), (other) => sameInput(other, row)),
										"the rows of one input are consecutive"
									)
								}
								assert.deepEqual(
									Arr.filter(ordered, (other) => sameInput(other, row)),
									Arr.filter(k.rows, (other) => sameInput(other, row)),
									"the rows of one input in the order they came"
								)
							}
							if (
								Arr.some(k.rows, (row, i) =>
									Arr.some(
										Arr.take(k.rows, i),
										(earlier, j) =>
											sameInput(earlier, row) &&
											Arr.some(
												Arr.take(Arr.drop(k.rows, j + 1), i - j - 1),
												(between) => !sameInput(between, row)
											)
									)
								)
							) {
								c.note("rows of one input split apart")
							}
						})
				)
			)
	)
})
