import { forwarded } from "#lint/fixtures/limit-evidence/clean.ts"
import {
	definePlan,
	drawSized,
	filter,
	integer,
	repeatedDraw
} from "#lint/fixtures/limit-evidence/tests/gen.ts"

declare const xs: ReadonlyArray<number>

export const sized = xs.length > 200

export const rows = Array.from({ length: 500 }, () => 0)

export const capped = Math.min(xs.length, 64)

export const cases = { maxDepth: 12, size: 1000 }

export const head = xs.slice(0, 10)

const caseCount = 300

export const spin = (): number => {
	let total = 0
	for (let i = 0; i < caseCount; i++) {
		total += i
	}
	return total
}

export const odd = filter(integer, (n) => n % 2 === 1, 100)

export const bounded = drawSized(integer, { attempts: 20, max: 50 })

const atLeast = (n: number): boolean => xs.length >= n

export const enough = atLeast(50)

export const redrawn = repeatedDraw(integer, 30)

export const elapsed = (start: number, end: number): boolean => end - start > 0

const drawAttempts = 30

export const even = filter(integer, (n) => n % 2 === 0, drawAttempts)

export const evenSized = drawSized(integer, { attempts: drawAttempts, max: 8 })

export const facts = { Wanted: [{ key: "a", due: 100n, attempts: 2 }] }

interface Phases {
	readonly setupMs: number
	readonly runMs: number
}

export const phases: Phases = { setupMs: 1, runMs: 2 }

const instant = (days: number, hours: number): number => days * 24 + hours

export const payday = instant(9, 15)

const daySeconds = 86_400

const millisPerSecond = 1000

export const conversions = [daySeconds, millisPerSecond] as const

export const plan = definePlan({ name: "poll", options: { wait: "5 seconds", rounds: 3 } })

export const subject = forwarded(16)

export const slowRecord = { timeout: 60_000 }

export const sizes = [{ name: "100 rows", rooms: 4 }] as const
