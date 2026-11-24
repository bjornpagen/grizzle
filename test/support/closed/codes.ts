/**
 * The test oracles of a closed constant (ir/cells.ts Constant): its two parallel arrays, the literals that state them,
 * and the reads PostgreSQL makes of them, each by the oracle's own arithmetic, sharing no code with the engine's encoder
 * or its SQL (testing doctrine, rule 3).
 *
 * A constant's cells are its entries' indexes in index order after the sentinel -1, and its payloads, where its payload
 * space holds more than one code, its entries' payload codes in the same order; each literal is its elements in
 * braces, comma-separated. A read is computed by scanning every cell, never by a search: a cell is held where an
 * element equals it, and its payload is the payloads' element at the same place, or 0 where no payloads are installed.
 */
import { Array as Arr } from "effect"
import type { Constant } from "#compiler/ir/cells.ts"

/** The index below every index a constant holds, which its cells' literal states first. */
const sentinel = -1n

/** A constant's cells as the oracle computes them: the sentinel, then each entry's index, in order. */
export const oracleCells = (constant: Constant): ReadonlyArray<bigint> => [
	sentinel,
	...Arr.map(constant.entries, (e) => e.index)
]

/** A constant's payloads as the oracle computes them: each entry's payload code, in order; none for one payload code. */
export const oraclePayloads = (constant: Constant): ReadonlyArray<bigint> | undefined =>
	constant.points > 1n ? Arr.map(constant.entries, (e) => e.payload) : undefined

/** An array's literal as the oracle spells it: its elements in decimal, comma-separated, in braces. */
export const oracleLiteral = (elements: ReadonlyArray<bigint>): string =>
	`{${Arr.join(
		Arr.map(elements, (element) => element.toString()),
		","
	)}}`

/**
 * The payload code a constant holds at cell `index`, read by scanning every element of its cells, the sentinel's place
 * aside, for one equal to it: the payloads' element at the place before it, or 0 where no payloads are installed; none
 * where no element equals it, an index past the last cell among them.
 */
export const payloadAt = (
	cells: ReadonlyArray<bigint>,
	payloads: ReadonlyArray<bigint> | undefined,
	index: bigint
): bigint | undefined => {
	const place = Arr.findFirstIndex(cells, (cell, i) => i > 0 && cell === index)
	return place._tag === "None" ? undefined : payloads === undefined ? 0n : payloads[place.value - 1]
}

/**
 * The run of `count` cells from cell `first` of a constant's cells, as a bit text: a 1 at each cell an element equals,
 * a 0 at every other, each cell read by payloadAt.
 */
export const runText = (cells: ReadonlyArray<bigint>, first: bigint, count: number): string =>
	Arr.join(
		Array.from({ length: count }, (_, at) =>
			payloadAt(cells, undefined, first + BigInt(at)) === undefined ? "0" : "1"
		),
		""
	)
