import { Duration, Effect, Schedule } from "effect"
import { filter, integer } from "#lint/fixtures/limit-evidence/tests/gen.ts"

export const pause = Effect.sleep(Duration.millis(20)) // violation

export const settled = Effect.forEach([1, 2], Effect.succeed, { concurrency: 8 }) // violation

export const flaky = Effect.retry(Effect.void, { times: 5 }) // violation

export const slow = AbortSignal.timeout(60_000) // violation

const settleMs = 100 // violation

export const settle = Effect.sleep(settleMs) // violation

declare const xs: ReadonlyArray<number>
declare const started: number

export const clamped = Effect.forEach([1, 2], Effect.succeed, {
	concurrency: Math.min(4, xs.length) // violation
})

export const polled = (): number => {
	let seen = 0
	for (let attempt = 0; attempt < 5; attempt++) { // violation
		seen += attempt
	}
	return seen
}

export const late = Date.now() - started > 5000 // violation

export const backoff = Schedule.exponential("10 millis", 2) // violation

const hold = (span: number) => Effect.sleep(span)

export const held = hold(30) // violation

export const countdown = (): number => {
	let retries = 3
	while (retries > 0) { // violation
		retries -= 1
	}
	return retries
}

const retryAttempts = 3 // violation

export const odd = filter(integer, (n) => n % 2 === 1, retryAttempts)

export const again = Effect.retry(Effect.void, { times: retryAttempts }) // violation

const dayMs = 86_400 // violation

const pollSeconds = 5 // violation

export const waits = [dayMs, pollSeconds] as const
