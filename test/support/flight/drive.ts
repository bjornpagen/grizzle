import { Clock, Effect, Exit, Fiber, Scheduler, Scope } from "effect"
import { TestClock } from "effect/testing"
import { abandonSilentRounds } from "#adapter/wire/batch.ts"
import type { ScriptedSession } from "#test/support/flight/scripted.ts"

export interface Timing {
	/** Interrupt once this many answers were delivered; undefined: never. */
	readonly interruptAfter: number | undefined
}

export type Driven<A, E> =
	| { readonly kind: "blocked" }
	| {
			readonly kind: "ran"
			readonly exit: Exit.Exit<A, E>
			/** The answers delivered when the interruption came; undefined when none came. */
			readonly interruptedAt: number | undefined
	  }

/**
 * Deterministic simulation of one call over a scripted session (scripted.ts): timing is an input of the test, never
 * the machine's.
 *
 * The call runs as a fiber on a scheduler whose queue runs only when the driver flushes it, under a TestClock, which
 * only the driver advances, and only for an interrupted call: an abandoned flight waits on the clock between its rounds
 * (batch.ts abandon). So every step happens in an order the driver chooses, and nothing else happens:
 *
 * 1. the call is forked and runs until it waits;
 * 2. the session delivers `interruptAfter` answers, one at a time, the fiber running to its next wait after each;
 * 3. unless the call has completed, it is interrupted there; with no interruption, a call that waits with nothing left
 *    to deliver is `blocked`: a statement runs until a CancelRequest that only an interruption sends;
 * 4. then answers are delivered as the server makes them, the connection's end among them once the call destroyed
 *    it, until the call completes; when nothing is left to deliver, the clock moves on by one connect timeout, ending
 *    the round the abandoned flight waits in. An interrupted call that waits through more silent rounds than abandon
 *    severs at (abandonSilentRounds, then the round that severs) is a defect: abandon never ended.
 *
 * The driver reports the exit, and how many answers had been delivered when the interruption came (none when the call
 * completed first, or none was asked for).
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
		if (!done()) {
			if (limit === undefined) {
				return { kind: "blocked" }
			}
			interruptedAt = session.deliveries()
			Effect.runFork(Fiber.interrupt(fiber), { scheduler })
			settle()
			/**
			 * The rounds in a row the abandoned flight has waited through with nothing delivered, and whether anything was
			 * delivered in the round under way, as abandon counts them (batch.ts afterRound).
			 */
			let silent = 0
			let answeredInRound = false
			while (!done()) {
				if (session.deliverable()) {
					answeredInRound = true
					deliver()
					continue
				}
				if (silent > abandonSilentRounds.value) {
					throw new Error(
						`the interrupted call waits with nothing left to deliver after ${silent} silent rounds`
					)
				}
				silent = answeredInRound ? 0 : silent + 1
				answeredInRound = false
				step(clock.adjust(session.connectTimeout))
			}
		}
		const exit = fiber.pollUnsafe()
		if (exit === undefined) {
			throw new Error("the call did not complete")
		}
		return { kind: "ran", exit, interruptedAt }
	} finally {
		step(Scope.close(scope, Exit.void))
	}
}
