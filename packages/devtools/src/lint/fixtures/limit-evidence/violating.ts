import { Duration, Effect, Schedule } from "effect"
import pageRowsDefault from "#lint/fixtures/limit-evidence/defaults.ts"
import { published, derived } from "#lint/fixtures/limit-evidence/limits.ts"
import { pageRows } from "#lint/fixtures/limit-evidence/reexports.ts"

declare const depth: number
declare const pairs: ReadonlyArray<string>
declare const text: string
declare const tick: () => void

export const tooDeep = depth > 8 // violation

const maxPairs = 6 // violation

export const tooMany = pairs.length > maxPairs // violation

export const walk = (): number => {
	let total = 0
	for (let steps = 0; steps < 10_000; steps++) { // violation
		total += steps
	}
	return total
}

const rounds = 12

export const spin = (): number => {
	let total = 0
	for (let round = 0; round < rounds; round++) { // violation
		total += round
	}
	return total
}

export const wait = Duration.seconds(5) // violation

export const nap = Effect.sleep(5000) // violation

export const textual = Effect.sleep("5 seconds") // violation

export const timer = setTimeout(tick, 50) // violation

export const pool = { idleTimeoutMs: 5_000, min: 1, max: 10 } // violation

const pageMaxSize = 1_000 // violation

export const overPage = (size: number): boolean => size > pageMaxSize // violation

export const clamped = Math.min(depth, 100) // violation

export const head = text.slice(0, 8) // violation

export const padded = text.padStart(4, "0") // violation

export const repeated = "=".repeat(3) // violation

export const grid = Array.from({ length: 9 }, () => 0) // violation

export const buffer = new Uint8Array(64) // violation

export const fallback = (max: number | undefined): boolean => depth > (max ?? 10) // violation

export const reserve = (max: number): boolean => depth > max - 8 // violation

export const defaulted = ({ cap = 12 }: { readonly cap?: number }): boolean => depth > cap // violation

const LIMITS = { maxDepth: 32 } as const // violation

export const overLimits = depth > LIMITS.maxDepth // violation

export const shifted = depth > 1 << 14 // violation

export const decimalCode = (code: number): boolean => code >= 48 && code <= 57 // violation

export const concurrent = Effect.forEach([1, 2], Effect.succeed, { concurrency: 4 }) // violation

export const retried = Effect.retry(Effect.void, { times: 3 }) // violation

export const bounded = Effect.timeoutOrElse(Effect.void, {
	duration: 50, // violation
	orElse: () => Effect.void
})

export const sleepFor = (ms = 250) => Effect.sleep(ms) // violation

const limitMs = 2 * 1000 // violation

export const graced = (timeoutMs: number) => Duration.millis(timeoutMs + 500) // violation

const fetchRows = (rows: ReadonlyArray<number>, limit: number): ReadonlyArray<number> =>
	rows.slice(0, limit)

export const firstRows = fetchRows([1, 2, 3], 100) // violation

const within = (wait: Duration.Input): Duration.Input => wait

export const waited = within(750) // violation

export const used = [limitMs] as const

declare const baseDelay: Duration.Duration

const forAll = (xs: ReadonlyArray<number>, width: number) =>
	Effect.forEach(xs, Effect.succeed, { concurrency: width })

export const wide = forAll([1], 16) // violation

const runAll = (options: Readonly<{ width: number }>) =>
	Effect.forEach([1], Effect.succeed, { concurrency: options.width })

export const wideObject = runAll({ width: 16 }) // violation

const runNested = ({ width }: Readonly<{ width: number }>) => forAll([1], width)

export const wideNested = runNested({ width: 32 }) // violation

const wideOptions = { width: 12 }

export const wideHeld = runAll(wideOptions) // violation

const pauseFor = (wait: number) => Effect.gen(function* () {
	yield* Effect.sleep(wait)
})

export const paused = pauseFor(250) // violation

export const backoff = Schedule.exponential(baseDelay, 2) // violation

export const recurring = Schedule.recurs(3) // violation

export const holes = Array(9).fill(0) // violation

export const hexCount = pairs.length > 0x40 // violation

const nestingLimit = published({ value: 8, owner: "the fixture", source: "https://example.com/n" })

const twice = nestingLimit.value * 2

export const overTwice = depth > twice // violation

export const reserved = pairs.length > nestingLimit.value - 8 // violation

const FROZEN = Object.freeze({ width: 24 })

export const overFrozen = depth > FROZEN.width // violation

export const laundered = derived({
	owner: "the fixture",
	from: [nestingLimit],
	derivation: "a number",
	compute: () => 5000 // violation
})

export const assigned = (target: { timeoutMs: number }): void => {
	target.timeoutMs = 5000 // violation
}

export const computed = Effect.forEach([1], Effect.succeed, { ["concurrency"]: 6 }) // violation

export const countdown = (): number => {
	let attempts = 3
	let tried = 0
	while (attempts > 0) { // violation
		attempts -= 1
		tried += 1
	}
	return tried
}

export const heldFallback = (options: Readonly<{ max?: number }>): boolean => {
	const cap = options.max ?? 10
	return depth > cap // violation
}

export const defaultObject = (options = { width: 24 }): boolean => depth > options.width // violation

enum Caps {
	Rows = 50
}

export const overRows = depth > Caps.Rows // violation

class Shelf {
	static readonly width = 18
}

export const overShelf = depth > Shelf.width // violation

export const overPage = depth > pageRows // violation

export const overDefault = depth > pageRowsDefault // violation

const limiter = (options: Readonly<{ window: Duration.Input }>) => options

export const windowed = limiter({ window: "1 second" }) // violation

const retriedFor = Effect.fn("retriedFor")(function* (span: number) {
	yield* Effect.sleep(span)
})

export const retriedNow = retriedFor(40) // violation

declare const elapsed: number

const budget = (spent: number): number => 60_000 + 3 * spent

export const budgeted = Effect.timeoutOption(Effect.void, Duration.millis(budget(elapsed))) // violation

const doubledWait = (wait: number): number => wait * 2

export const doubledSleep = Effect.sleep(doubledWait(400)) // violation

const relayedWait = (wait: number): number => doubledWait(wait)

export const relayedSleep = Effect.sleep(relayedWait(300)) // violation

function graceOf(late: boolean): number {
	if (late) {
		return elapsed
	}
	return 250
}

export const graceful = Duration.millis(graceOf(true)) // violation

const sleepDoubled = (wait: number) => Effect.sleep(doubledWait(wait))

export const sleptDoubled = sleepDoubled(125) // violation
