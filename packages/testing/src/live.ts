import { Clock, Duration, Effect, Fiber } from "effect"

/** A sleep on the live clock, whatever clock the caller runs under: a hang guard must not wait on a TestClock. */
export const liveSleep = (duration: Duration.Input) =>
	Effect.sleep(duration).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()))

/** The live clock's time, whatever clock the caller runs under: a budget of wall time reads it. */
export const liveMillis = Clock.currentTimeMillis.pipe(
	Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())
)

/**
 * How long a hung fiber's cleanup may run once a guard has interrupted it, on the live clock. Cleanup that waits on a
 * clock the work froze (a TestClock no one advances) or on a server that never answers would never end, so a guard
 * reports the hang once this grace has passed, whether or not the cleanup finished, and never waits on it longer.
 */
const HUNG_CLEANUP_GRACE = Duration.seconds(5)

/** Interrupts a hung fiber and waits for its cleanup for HUNG_CLEANUP_GRACE at most, never longer. */
export const stopHung = <A, E>(running: Fiber.Fiber<A, E>): Effect.Effect<void> =>
	Effect.andThen(
		Effect.forkDetach(Fiber.interrupt(running)),
		Effect.raceFirst(Effect.asVoid(Fiber.await(running)), liveSleep(HUNG_CLEANUP_GRACE))
	)
