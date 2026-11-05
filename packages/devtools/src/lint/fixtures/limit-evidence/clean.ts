import { Array as Arr, Duration, Effect } from "effect"
import { derived, published } from "#lint/fixtures/limit-evidence/limits.ts"

declare const depth: number
declare const text: string
declare const bytes: Uint8Array
declare const pool: Readonly<{ max: number; idleTimeoutMs: number }>

const nestingMax = published({ value: 8, owner: "the fixture", source: "https://example.com/nesting" })

export const tooDeep = depth > nestingMax.value

export const doubled = derived({
	owner: "the fixture",
	from: [nestingMax],
	derivation: "twice the nesting bound, less the frame the root takes",
	compute: ([nesting]) => Math.max(nesting.value * 2 - 16, 0)
})

const maxBytes = nestingMax.value

export const overBytes = bytes.length > maxBytes

export const sized = { max: pool.max, idleTimeoutMs: pool.idleTimeoutMs }

export const waited = Duration.millis(pool.idleTimeoutMs)

export const converted = Duration.millis(pool.idleTimeoutMs * 1000)

export const zero = Duration.millis(0)

export const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39

export const isScalar = (c: number): boolean => c <= 0x10ffff

export const lowBits = (b: number): number => b & 0x3f

export const isEven = (n: number): boolean => n % 2 === 0

export const last = (xs: ReadonlyArray<number>): number | undefined => xs.at(-1)

export const third = (xs: ReadonlyArray<number>): number | undefined => xs[2]

export const nonEmpty = (xs: ReadonlyArray<number>): boolean => xs.length > 0

export const many = (xs: ReadonlyArray<number>): boolean => xs.length >= 2

export const few = (xs: ReadonlyArray<number>): boolean => xs.length < 2

export const nonNegative = (x: number): boolean => x > -1

export const tail = text.slice(1)

export const lastCharacter = text.slice(-1)

export const quad = (i: number): boolean => i + 4 <= text.length

export const escape = (i: number): string => text.slice(i + 2, i + 6)

export const power = (k: number): number => 2 ** k

export const scaled = (precision: number): bigint => 10n ** BigInt(precision)

/**
 * @formatConstant a UUID's first group is 8 hexadecimal digits
 */
const uuidGroupWidth = 8

export const group = text.slice(0, uuidGroupWidth)

export const existence = { limit: 1 }

export const unbounded = Effect.forEach([1, 2], Effect.succeed, { concurrency: "unbounded" })

export const hex = (n: number): string => n.toString(16)

export const parsed = Number.parseInt("ff", 16)

export const unit = text.charCodeAt(3)

export const sum = (): number => {
	let total = 0
	for (let i = 0; i < text.length; i++) {
		total += text.charCodeAt(i)
	}
	return total
}

export const capped = (limit: number): number => Math.min(depth, limit)

/**
 * @formatConstant IEEE 754 binary32's exponent range and significand width
 */
const binary32 = { bits: 24, minExp: -126, maxExp: 127 } as const

export const exponentOf = (e: number): number => Math.max(e, binary32.minExp)

export const literal = { column: "c", length: 2, elements: [] }

const forAll = (xs: ReadonlyArray<number>, width: number) =>
	Effect.forEach(xs, Effect.succeed, { concurrency: width })

export const sequential = forAll([1], 1)

export const fromPool = forAll([1], pool.max)

export const forwarded = (width: number) => forAll([1], width)

const scale = (x: number, factor: number): number => x * factor

export const tripled = scale(depth, 3)

const atLeast = (xs: ReadonlyArray<number>, n: number): boolean => xs.length >= n

export const several = atLeast([1, 2], 2)

const between = (c: number, lo: number, hi: number): boolean => c >= lo && c <= hi

export const isUpperHex = (code: number): boolean => between(code, 0x41, 0x46)

export const isAscii = (code: number): boolean => code < 0x80

export const skipHeader = (): number => {
	let total = 0
	for (let i = 3; i < text.length; i++) {
		total += text.charCodeAt(i)
	}
	return total
}

export const fromTwo = (limit: number): number => {
	let total = 0
	for (let n = 2; n < limit; n++) {
		total += n
	}
	return total
}

const nestingCap = BigInt(nestingMax.value)

export const overCap = BigInt(depth) > nestingCap

export const underNesting = depth > nestingMax.value - 1

/**
 * @formatConstant RGB has three channels
 */
const RGB = Object.freeze({ channels: 3 })

export const overChannels = depth > RGB.channels

export const fromOptions = (options: Readonly<{ width: number }>) =>
	Effect.forEach([1], Effect.succeed, { concurrency: options.width })

export const settings = { width: 4, label: "x" }

export const words = (attempt: string): string => attempt

export const powerOfTen = (digits: number): bigint => 10n ** BigInt(digits) * BigInt(nestingMax.value)

export const scaledUnit = 10n ** BigInt(nestingMax.value)

export const halfway = (n: number): boolean => n * 2 > nestingMax.value

export const accumulate = (values: ReadonlyArray<number>, into: { max: number }): void => {
	let max = -1
	for (const value of values) {
		max = Math.max(max, value)
	}
	into.max = max
}

const literals = [1, 2].map((column) => ({ column, length: 2 }))

export const grown = (limit: number): boolean => Arr.some(literals, (literal) => literal.length + 1 > limit)

type Group = 0 | 1 | 2

const groupWidths = [8, 4, 4] as const

const groupStart = (group: Group): number => groupWidths.slice(0, group).length

export const second = groupStart(2)

const sign = (n: bigint): boolean => n < 0n

export const huge = sign(2n ** 1024n)

const describeTimeout = (timeoutMs: number): string => `${timeoutMs} ms`

export const described = describeTimeout(5000)

export const decimalValue = (value: number, c: number): number =>
	Math.min(value * 10 + (c - 0x30), Number.MAX_SAFE_INTEGER)

const nestingOf = (): number => nestingMax.value

export const underNestingOf = depth > nestingOf()

const rank = (first: boolean) => (first ? 1 : 2)

export const ranked = rank(true) < rank(false)

const elapsedSince = (start: number): number => Date.now() - start

export const waitedSince = Duration.millis(elapsedSince(depth))

const settle = Effect.fn("settle")(function* (wait: number) {
	yield* Effect.void
	return wait
})

export const settled = settle(5000)

const doubledCount = (n: number): number => n * 2

export const doubledDepth = Duration.millis(doubledCount(depth))
