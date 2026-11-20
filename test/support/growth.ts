/**
 * Linear growth, stated exactly. A size that grows linearly in one dimension of its input has no term above linear, so
 * over three sizes of the dimension an equal step apart its increment over the second step is never larger than over
 * the first; a size with a term above linear, such as an object that names every pair of the dimension's items,
 * increments by more over each later step, at every size, where a ratio between n and 2n with slack refuses it only
 * once its square outgrows the slack. No slack is needed: the two forms below are exact.
 *
 * - `affine`: the second increment is the first, f(3n) − f(2n) = f(2n) − f(n). The contract of a size made of a fixed
 *   part and a fixed part per item, each item of the dimension alike, whatever the sign of its intercept (n − 1 items
 *   alike beside one apart).
 * - `incrementsDoNotGrow`: the second increment is at most the first, sampled at 2h, 4h and 6h, so every size it reads
 *   is even. The contract "grows no faster than linearly": an affine size, a size with floor effects (⌈n / 2⌉ objects
 *   for n items paired up, which over even sizes is affine), and a size that saturates.
 * - `incrementsAtMostDouble`: the second increment is at most twice the first. The contract "grows no faster than
 *   quadratically": a size an² + bn + c with a, b ≥ 0, a fixed part per item and per pair of items, increments by
 *   3an² + bn and then 5an² + bn, which is at most twice the first; a size with a term in n³ increments by 7 and then 19
 *   times it, more than twice.
 *
 * Neither form holds a size that changes shape above some size of its dimension, an object that appears only past a
 * threshold, whose step lands in one increment alone: a suite that measures such a size states it in its header.
 */
import { assert } from "@bjornpagen/testing/assert"

/** A size of one dimension's input: what a suite measures (AST nodes, calls) at each size of the dimension. */
type Measure = (size: number) => number

/** The increments of `f` over the two equal steps from `n` to 3n, each with the sizes it reads, for a report. */
const incrementsOf = (f: Measure, n: number) => {
	const first = f(n)
	const second = f(2 * n)
	const third = f(3 * n)
	return {
		before: second - first,
		after: third - second,
		text: `${first} at ${n}, ${second} at ${2 * n}, ${third} at ${3 * n}`
	}
}

/** That `f`, `what` names it, is exactly affine in its dimension: its increments from n to 2n and from 2n to 3n agree. */
export const affine = (f: Measure, n: number, what: string): void => {
	const { before, after, text } = incrementsOf(f, n)
	assert.equal(after, before, `${what} is affine: ${text}`)
}

/**
 * That `f`, `what` names it, grows no faster than linearly: sampled at 2·half, 4·half and 6·half, every size even, its
 * increment over the second step is at most its increment over the first.
 */
export const incrementsDoNotGrow = (f: Measure, half: number, what: string): void => {
	const { before, after, text } = incrementsOf(f, 2 * half)
	assert.ok(after <= before, `${what} grows faster than linearly: ${text}`)
}

/**
 * That `f`, `what` names it, grows no faster than quadratically: its increment from 2n to 3n is at most twice its
 * increment from n to 2n.
 */
export const incrementsAtMostDouble = (f: Measure, n: number, what: string): void => {
	const { before, after, text } = incrementsOf(f, n)
	assert.ok(after <= 2 * before, `${what} grows faster than quadratically: ${text}`)
}
