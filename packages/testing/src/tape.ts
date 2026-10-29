import { Array as Arr, String as Str } from "effect"

/**
 * How a recording ended. A replay that ran past its values, or met a value its decision no longer allows, finished on
 * simplest values (`overrun`). A filter that found no value it keeps gave up (`discarded`), and the case never runs.
 */
export type Status = "complete" | "overrun" | "discarded"

/**
 * Everything a case decided, in typed buffers: decision `i` chose `values[i]` between `lo[i]` and `hi[i]`, inclusive,
 * whose simplest value is `lo[i]`; span `j` labels the decisions `[spanStart[j], spanEnd[j])` at `spanDepth[j]`. Every
 * decision a generator makes is one of these, so replaying, enumerating, mutating and shrinking a case all work on one
 * representation, and changing one decision changes exactly the decision it was. The buffers hold exactly `length`
 * decisions and `spanLabel.length` spans; nothing per decision is an object, so recording and editing a case allocate
 * nothing in the loop. Values are whole numbers held exactly in doubles.
 */
export type Tape = Readonly<{
	length: number
	values: Float64Array
	lo: Float64Array
	hi: Float64Array
	spanStart: Int32Array
	spanEnd: Int32Array
	spanDepth: Int32Array
	spanLabel: ReadonlyArray<string>
	status: Status
}>

/** The values of a tape as an array, for reports and assertions; the engine itself works on the buffer. */
export const valuesOf = (tape: Tape): ReadonlyArray<number> => Arr.fromIterable(tape.values)

/**
 * The order shrinking descends: fewer decisions first, then smaller values position by position. Every accepted
 * shrink is strictly smaller in it, so shrinking always ends. Compares without copying.
 */
export const shortlex = (
	left: Float64Array,
	leftLength: number,
	right: Float64Array,
	rightLength: number
): -1 | 0 | 1 => {
	if (leftLength !== rightLength) {
		return leftLength < rightLength ? -1 : 1
	}
	for (let at = 0; at < leftLength; at += 1) {
		const a = left[at] ?? 0
		const b = right[at] ?? 0
		if (a !== b) {
			return a < b ? -1 : 1
		}
	}
	return 0
}

/**
 * A 53-bit digest of values: two FNV-1a lanes over each value's two 32-bit halves, joined into one double. Candidates
 * are deduplicated by it, so a shrink or a mutation never runs the same values twice, with no string built per
 * candidate.
 */
export const digestOf = (values: Float64Array, length: number): number => {
	let h1 = 0x811c_9dc5
	let h2 = 0x01_00_01b3 ^ length
	for (let at = 0; at < length; at += 1) {
		const value = values[at] ?? 0
		const low = value >>> 0
		const high = Math.floor(value / 0x1_0000_0000) >>> 0
		h1 = Math.imul(h1 ^ low, 0x0100_0193)
		h1 = Math.imul(h1 ^ high, 0x0100_0193)
		h2 = Math.imul(h2 ^ low, 0x5bd1_e995)
		h2 = Math.imul(h2 ^ (h2 >>> 15) ^ high, 0x2735_6b7b)
	}
	return (h1 >>> 0) * 0x20_0000 + ((h2 >>> 0) >>> 11)
}

const TOKEN_SEPARATOR = "."

/** A tape's values as a compact token a person can paste back to replay exactly that case. */
export const tokenOf = (values: Float64Array, length: number): string =>
	Arr.join(
		Arr.map(Arr.fromIterable(values.subarray(0, length)), (value) => value.toString(36)),
		TOKEN_SEPARATOR
	)

/** The values a replay token carries. */
export const valuesFromToken = (token: string): Float64Array =>
	token === ""
		? new Float64Array(0)
		: Float64Array.from(Str.split(token, TOKEN_SEPARATOR), (part) => Number.parseInt(part, 36))
