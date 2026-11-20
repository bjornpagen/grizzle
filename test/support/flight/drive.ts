import { Array as Arr, Clock, Effect, Exit, Fiber, Scheduler, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { ScriptedSession } from "#test/support/flight/scripted.ts"

export interface Timing {
	/** Interrupt once this many answers were delivered; undefined: never. */
	readonly interruptAfter: number | undefined
}

/**
 * Where a run's interruption came, as the driver decided it: none, or once `at` answers had been delivered, when the
 * client had sent the server `sent` queries over every flight and the server had made `made` answers, every one it
 * could: each query's up to a statement that waits for a CancelRequest (scripted.ts). A server check holds a real
 * session there and finds the real pair as the scripted one stood (test/pg/adapter/flight.test.ts).
 */
export type Interruption =
	| { readonly at: undefined }
	| { readonly at: number; readonly sent: number; readonly made: number }

export type Driven<A, E> =
	| { readonly kind: "blocked" }
	| {
			readonly kind: "ran"
			readonly exit: Exit.Exit<A, E>
			readonly interruption: Interruption
	  }

/** Where the session stands when the driver interrupts its call: its deliveries, the queries sent and the answers made. */
const standing = (session: ScriptedSession): Interruption => {
	const flights = session.flights()
	return {
		at: session.deliveries(),
		sent: Arr.reduce(flights, 0, (n, flight) => n + flight.pipeline.length),
		made: Arr.reduce(
			flights,
			0,
			(n, flight) => n + Arr.filter(flight.made, (answer) => answer !== undefined).length
		)
	}
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
 *    severs at (the excused one, then the one that severs) is a defect: abandon never ended.
 *
 * The driver reports the exit, and where the interruption came (Interruption: none when the call completed first, or
 * none was asked for).
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
		let interruption: Interruption = { at: undefined }
		if (!done()) {
			if (limit === undefined) {
				return { kind: "blocked" }
			}
			interruption = standing(session)
			Effect.runFork(Fiber.interrupt(fiber), { scheduler })
			settle()
			/**
			 * The silence the abandoned flight's next round may meet, as abandon reads it (batch.ts Silence), or
			 * `severing` once a silent round has spent it, and whether anything was delivered in the round under way.
			 */
			let silence: "excused" | "spent" | "severing" = "excused"
			let answeredInRound = false
			while (!done()) {
				if (session.deliverable()) {
					answeredInRound = true
					deliver()
					continue
				}
				if (silence === "severing") {
					throw new Error("the interrupted call waits on past the silent round that severs it")
				}
				silence = answeredInRound ? "excused" : silence === "excused" ? "spent" : "severing"
				answeredInRound = false
				step(clock.adjust(session.connectTimeout))
			}
		}
		const exit = fiber.pollUnsafe()
		if (exit === undefined) {
			throw new Error("the call did not complete")
		}
		return { kind: "ran", exit, interruption }
	} finally {
		step(Scope.close(scope, Exit.void))
	}
}
