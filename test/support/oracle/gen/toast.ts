import { Array as Arr, String as Str } from "effect"
import { cyclicAt } from "#test/support/oracle/pick.ts"
const alphabet: ReadonlyArray<string> = [
	...Str.split("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ", ""),
	"é",
	"ß",
	"Ж",
	"ת",
	"中",
	"ア",
	"\u{1F600}",
	"\u{10FFFF}",
	"\u{E000}"
]

/**
 * Text values large enough to be TOASTed.
 *
 * PostgreSQL moves a row's varlena values out of line once the row passes its TOAST threshold (about 2 kB), first
 * trying to compress them in place. A long run of one character compresses to a few bytes and stays inline, so a value
 * that must be stored out of line is incompressible: pseudo-random code points drawn from a deterministic stream. Each
 * value here is a pure function of its seed and length, so a generated case prints and replays as numbers.
 *
 * The alphabet mixes ASCII letters and digits with two-byte, three-byte and four-byte UTF-8 code points, so a detoasted
 * value's byte length, character count and code point order are all exercised, and a slice of one never ends inside a
 * surrogate pair.
 *
 * A deterministic, incompressible text of `length` code points from `seed`.
 *
 * xorshift32.
 */
export const toastText = (seed: number, length: number): string => {
	let state = (seed * 0x9e37_79b1 + 0x7f4a_7c15) >>> 0
	const out: Array<string> = []
	for (let i = 0; i < length; i++) {
		state ^= state << 13
		state >>>= 0
		state ^= state >>> 17
		state ^= state << 5
		state >>>= 0
		out.push(cyclicAt(alphabet, state, "the alphabet"))
	}
	return Arr.join(out, "")
}

/**
 * The lengths of TOAST-sized values: past the threshold, a few times past it, and past one TOAST chunk several times.
 */
export const toastLengths: ReadonlyArray<number> = [2_100, 6_000, 20_000]

/**
 * Two TOAST-sized texts that share a long prefix and differ only at their end, so a comparison must read past every
 * chunk but the last to tell them apart.
 */
export const toastPair = (seed: number, length: number): readonly [string, string] => {
	const prefix = toastText(seed, length - 1)
	return [`${prefix}a`, `${prefix}b`]
}
