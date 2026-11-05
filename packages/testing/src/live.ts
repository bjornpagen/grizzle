import { Clock, Duration, Effect, Fiber } from "effect"

/** A sleep on the live clock, whatever clock the caller runs under: a hang guard must not wait on a TestClock. */
export const liveSleep = (duration: Duration.Input) =>
	Effect.sleep(duration).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()))

/** The live clock's time, whatever clock the caller runs under: a budget of wall time reads it. */
export const liveMillis = Clock.currentTimeMillis.pipe(
	Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())
)

/**
 * A sleep on the live clock until it reads `moment`, in milliseconds since the epoch, or later. A timer may fire a
 * millisecond before the clock reads its moment, so the sleep sleeps again until it does, and whatever reads the clock
 * once it has ended finds the moment passed.
 */
export const liveSleepUntil = (moment: number): Effect.Effect<void> =>
	Effect.flatMap(liveMillis, (now) =>
		now >= moment
			? Effect.void
			: Effect.andThen(liveSleep(Duration.millis(moment - now)), liveSleepUntil(moment))
	)

/**
 * How long a hung fiber's cleanup may run once a guard has interrupted it, on the live clock. Cleanup that waits on a
 * clock the work froze (a TestClock no one advances) or on a server that never answers would never end, so a guard
 * reports the hang once this grace has passed, whether or not the cleanup finished, and never waits on it longer.
 */
const HUNG_CLEANUP_GRACE = Duration.seconds(5)

/** Interrupts a fiber and never waits for its cleanup, which runs on in a fiber of its own. */
export const abandon = <A, E>(running: Fiber.Fiber<A, E>): Effect.Effect<void> =>
	Effect.asVoid(Effect.forkDetach(Fiber.interrupt(running)))

/** Interrupts a hung fiber and waits for its cleanup for HUNG_CLEANUP_GRACE at most, never longer. */
export const stopHung = <A, E>(running: Fiber.Fiber<A, E>): Effect.Effect<void> =>
	Effect.andThen(
		abandon(running),
		Effect.raceFirst(Effect.asVoid(Fiber.await(running)), liveSleep(HUNG_CLEANUP_GRACE))
	)
