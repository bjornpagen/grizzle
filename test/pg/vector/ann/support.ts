import { Array as Arr } from "effect"
import { trusted } from "#compiler/core/trusted.ts"

/** The dimension count of the vectors drawn here. */
export const dimensions = 8

/** A xorshift32 generator. */
export const generator = (seed: number) => {
	const unsigned = seed >>> 0
	let state = unsigned === 0 ? 1 : unsigned
	return (): number => {
		state ^= state << 13
		state >>>= 0
		state ^= state >>> 17
		state ^= state << 5
		state >>>= 0
		return state / 0x100000000
	}
}

/** A unit vector of binary32 components, written as the shortest text of each binary32 value. */
export const unitVector = (next: () => number): ReadonlyArray<number> => {
	const raw = Array.from({ length: dimensions }, () => next() * 2 - 1)
	const norm = Math.sqrt(Arr.reduce(raw, 0, (s, x) => s + x * x))
	return Arr.map(raw, (x) => Math.fround(x / norm))
}

export const vectorText = (components: ReadonlyArray<number>): string =>
	`[${Arr.join(
		Arr.map(components, (c) => (Object.is(c, -0) ? "0" : String(c))),
		","
	)}]`

/** Rows of text columns from PostgreSQL, trusted as such: every statement here casts each result column to text. */
export const textRows = (rows: unknown): ReadonlyArray<ReadonlyArray<string>> =>
	trusted<ReadonlyArray<ReadonlyArray<string>>>(rows)
