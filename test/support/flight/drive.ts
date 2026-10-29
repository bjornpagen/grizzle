import { Clock, Effect, Exit, Fiber, Scheduler, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { ScriptedSession } from "#test/support/flight/scripted.ts"

export interface Timing {
	/** Interrupt once this many answers were delivered; undefined: never. */
	readonly interruptAfter: number | undefined
	/** The answers delivered after the interruption before the cancellation grace expires. */
	readonly grace: number
}

export type Driven<A, E> =
	| { readonly kind: "blocked" }
	| {
			readonly kind: "ran"
			readonly exit: Exit.Exit<A, E>
			/** The answers delivered when the interruption came; undefined when none came. */
			readonly interruptedAt: number | undefined
			/** The answers delivered after it before the grace expired. */
			readonly graceDeliveries: number
	  }

/** The adapter's cancellation grace, the first step the clock takes once the call is interrupted. */
const graceMillis = 10

/**
 * The steps the clock takes after the grace while no answer is owed: the backoff's smallest gap, so no step passes two
 * of the adapter's waits.
 */
const stepMillis = 50

/**
 * How long a call may take to drain once interrupted: past the adapter's drain deadline, 5 s after its first
 * CancelRequest, which destroys the connection.
 */
const drainLimitMillis = 6_000

/**
 * Deterministic simulation of one call over a scripted session (scripted.ts): timing is an input of the test, never
 * the machine's.
 *
 * The call runs as a fiber on a scheduler whose queue runs only when the driver flushes it, under a TestClock, which
 * every wait of the adapter is on (the cancellation grace, its backoff, the drain deadline), and which advances only
 * when the driver adjusts it. So every step happens in an order the driver chooses, and nothing else happens:
 *
 * 1. the call is forked and runs until it waits;
 * 2. the session delivers `interruptAfter` answers, one at a time, the fiber running to its next wait after each;
 * 3. unless the call has completed, it is interrupted there; with no interruption, a call that waits with nothing left
 *    to deliver is `blocked`: a statement runs until a CancelRequest that only an interruption sends;
 * 4. the session delivers `grace` more answers before the cancellation grace expires;
 * 5. then answers are delivered as the server makes them, and the clock advances only while none is owed, until the
 *    call completes. A call that has not drained within the limit, past the adapter's drain deadline, is a defect.
 *
 * The driver reports the exit, how many answers had been delivered when the interruption came (none when the call
 * completed first, or none was asked for), and how many more came before the grace expired.
 */
export const drive = <A, E>(
	session: ScriptedSession,
	call: Effect.Effect<A, E>,
	timing: Timing
): Driven<A, E> => {
	const dispatcher = new Scheduler.MixedScheduler("sync", () => () => undefined).makeDispatcher()
	const scheduler: Scheduler.Scheduler = {
		executionMode: "sync",
		shouldYield: () => false,
		makeDispatcher: () => dispatcher
	}
	const settle = (): void => dispatcher.flush()
	/** One of the driver's own steps, run to its end. */
	const step = <B>(effect: Effect.Effect<B>): B => {
		const fiber = Effect.runFork(effect, { scheduler })
		settle()
		const exit = fiber.pollUnsafe()
		if (exit === undefined || Exit.isFailure(exit)) {
			throw new Error("a step of the driver did not complete")
		}
		return exit.value
	}
	const scope = step(Scope.make())
	try {
		const clock = step(Effect.provideService(TestClock.make(), Scope.Scope, scope))
		const fiber = Effect.runFork(call.pipe(Effect.provideService(Clock.Clock, clock)), {
			scheduler
		})
		const done = (): boolean => fiber.pollUnsafe() !== undefined
		const deliver = (): void => {
			session.deliver()
			settle()
		}
		settle()
		const limit = timing.interruptAfter
		/** Whether the session may deliver more before the interrupt: no interrupt, or fewer deliveries than its point. */
		const beforeInterrupt = (): boolean => limit === undefined || session.deliveries() < limit
		while (!done() && session.deliverable() && beforeInterrupt()) {
			deliver()
		}
		let interruptedAt: number | undefined
		let graceDeliveries = 0
		if (!done()) {
			if (limit === undefined) {
				return { kind: "blocked" }
			}
			interruptedAt = session.deliveries()
			Effect.runFork(Fiber.interrupt(fiber), { scheduler })
			settle()
			while (!done() && session.deliverable() && graceDeliveries < timing.grace) {
				deliver()
				graceDeliveries++
			}
			let simulated = 0
			const advance = (millis: number): void => {
				if (simulated >= drainLimitMillis) {
					throw new Error(
						`the interrupted call did not drain within ${drainLimitMillis} ms of its interruption`
					)
				}
				step(clock.adjust(millis))
				simulated += millis
			}
			if (!done()) {
				advance(graceMillis)
			}
			while (!done()) {
				if (session.deliverable()) {
					deliver()
				} else {
					advance(stepMillis)
				}
			}
		}
		const exit = fiber.pollUnsafe()
		if (exit === undefined) {
			throw new Error("the call did not complete")
		}
		return { kind: "ran", exit, interruptedAt, graceDeliveries }
	} finally {
		step(Scope.close(scope, Exit.void))
	}
}
