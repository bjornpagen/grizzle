import { isMainThread, Worker } from "node:worker_threads"
import { Array as Arr, Clock, Duration, Effect, Fiber, Record as Rec } from "effect"

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

/**
 * Where the watchdog's two threads meet in their shared memory: three Int32 counters (bumped when the earliest moment
 * moves earlier; the last ping the main thread answered; one nothing writes, for the watchdog's thread to time a wait
 * on), then, at the first 8-byte boundary past them, two Float64 moments (the earliest moment a case in flight passes
 * its hang limit, in milliseconds since the epoch, and how long that case's thread then has to answer, in
 * milliseconds).
 */
const LAYOUT = {
	generation: 0,
	pong: 1,
	timer: 2,
	counters: 3,
	earliest: 0,
	grace: 1,
	moments: 2,
	momentsOffset: 16,
	bytes: 32
} as const

type Layout = typeof LAYOUT

/**
 * The watchdog's thread, evaluated from its source text in a worker of its own, so it reads no module of the library
 * and none a transform could rewrite, only Node's built-ins. It sleeps until the earliest moment a case in flight
 * passes its hang limit; then it pings the main thread and waits that case's grace for the answer. A main thread that
 * answers is alive, so the case's own guard reports it, and the thread sleeps on. One that does not answer
 * is running JavaScript that never yields, a synchronous loop its guard cannot interrupt, since the guard's timer runs
 * on the thread the loop holds: the thread asks it, through the inspector, which interrupts even a synchronous loop, for
 * its watchdog's report, writes the report to the process's stderr, and ends the process with SIGKILL, the one signal a
 * blocked thread cannot hold. A main thread whose inspector does not answer either is ended after the grace once more,
 * with a report that says only that. Its open port keeps it alive; the main thread unrefs it. Its layout is its
 * argument, written into its source text, since the thread shares no module with the main thread.
 */
const watchdogThread = (layout: Layout): void => {
	const threads = process.getBuiltinModule("node:worker_threads")
	const { Session } = process.getBuiltinModule("node:inspector")
	const { writeSync } = process.getBuiltinModule("node:fs")
	const port = threads.parentPort
	if (port === null || !(threads.workerData instanceof SharedArrayBuffer)) {
		return
	}
	const shared: SharedArrayBuffer = threads.workerData
	const counters = new Int32Array(shared, 0, layout.counters)
	const moments = new Float64Array(shared, layout.momentsOffset, layout.moments)
	const nowMillis = () => performance.timeOrigin + performance.now()
	const after = (waited: ReturnType<typeof Atomics.waitAsync>, then: () => void): void => {
		if (waited.async) {
			void waited.value.then(then)
		} else {
			void Promise.resolve().then(then)
		}
	}
	const end = (report: string): void => {
		writeSync(2, `\n${report}\n`)
		process.kill(process.pid, "SIGKILL")
	}
	const blocked = (graceMillis: number): void => {
		const unanswered =
			"@grizzle/testing: a case held its process's main thread past its hang limit without yielding, and the thread's inspector did not answer for its report; the watchdog ended the process: a hang"
		const session = new Session()
		session.connectToMainThread()
		session.post(
			"Runtime.evaluate",
			{ expression: "globalThis.grizzleTestingWatchdog?.blocked()", returnByValue: true },
			(error, evaluated) => {
				const report: unknown = error === null ? evaluated.result.value : undefined
				end(typeof report === "string" ? report : unanswered)
			}
		)
		after(Atomics.waitAsync(counters, layout.timer, 0, graceMillis), () => end(unanswered))
	}
	let pinged = 0
	const watch = (): void => {
		const generation = Atomics.load(counters, layout.generation)
		const hangsAt = moments[layout.earliest] ?? Number.POSITIVE_INFINITY
		const graceMillis = moments[layout.grace] ?? 0
		const waitMillis = hangsAt - nowMillis()
		if (waitMillis > 0) {
			after(Atomics.waitAsync(counters, layout.generation, generation, waitMillis), watch)
			return
		}
		pinged += 1
		const ping = pinged
		const answered = Atomics.load(counters, layout.pong)
		port.postMessage(ping)
		after(Atomics.waitAsync(counters, layout.pong, answered, graceMillis), () => {
			if (Atomics.load(counters, layout.pong) === ping) {
				after(
					Atomics.waitAsync(
						counters,
						layout.generation,
						Atomics.load(counters, layout.generation),
						graceMillis
					),
					watch
				)
			} else {
				blocked(graceMillis)
			}
		})
	}
	port.on("message", () => undefined)
	watch()
}

/** A case the watchdog watches: when it passes its hang limit, how long the thread then has to answer, and its report
 * should it block. */
type Watched = Readonly<{ hangsAt: number; graceMillis: number; report: () => string }>

/**
 * This process's watchdog of its main thread, for the hangs a case's own guard cannot stop: a case that loops
 * synchronously holds the thread its guard's timer would run on. `watch` registers a case in flight and returns its
 * release; `blocked` is what the watchdog's thread prints when the main thread has stopped answering, every case in
 * flight, since it cannot tell which one holds the thread. A process whose tests run off its main thread, in a worker,
 * has none: its watch does nothing, and only the guard's timer stops a case.
 */
export type Watchdog = Readonly<{
	watch: (watched: Watched) => () => void
	blocked: () => string
}>

declare global {
	var grizzleTestingWatchdog: Watchdog | undefined
}

/** The watchdog of a process whose tests do not run on its main thread: it watches nothing. */
const offMainThread: Watchdog = {
	watch: () => () => undefined,
	blocked: () => ""
}

/** Starts this process's watchdog: its thread, its shared memory, and the cases it watches. */
const startedWatchdog = (): Watchdog => {
	const shared = new SharedArrayBuffer(LAYOUT.bytes)
	const counters = new Int32Array(shared, 0, LAYOUT.counters)
	const moments = new Float64Array(shared, LAYOUT.momentsOffset, LAYOUT.moments)
	moments[LAYOUT.earliest] = Number.POSITIVE_INFINITY
	const layout = `{ ${Arr.join(
		Arr.map(Rec.toEntries(LAYOUT), ([name, at]) => `${name}: ${at}`),
		", "
	)} }`
	const worker = new Worker(`(${watchdogThread.toString()})(${layout})`, {
		eval: true,
		workerData: shared
	})
	worker.on("message", (ping: unknown) => {
		if (typeof ping === "number") {
			Atomics.store(counters, LAYOUT.pong, ping)
			Atomics.notify(counters, LAYOUT.pong)
		}
	})
	worker.unref()
	const inFlight = new Map<number, Watched>()
	let watched = 0
	const publish = () => {
		const earliest = Arr.reduce(
			Arr.fromIterable(inFlight.values()),
			{ hangsAt: Number.POSITIVE_INFINITY, graceMillis: 0 },
			(first, watch) => (watch.hangsAt < first.hangsAt ? watch : first)
		)
		const earlier = earliest.hangsAt < (moments[LAYOUT.earliest] ?? Number.POSITIVE_INFINITY)
		moments[LAYOUT.earliest] = earliest.hangsAt
		moments[LAYOUT.grace] = earliest.graceMillis
		if (earlier) {
			Atomics.add(counters, LAYOUT.generation, 1)
			Atomics.notify(counters, LAYOUT.generation)
		}
	}
	return {
		watch: (watch) => {
			watched += 1
			const id = watched
			inFlight.set(id, watch)
			publish()
			return () => {
				inFlight.delete(id)
				publish()
			}
		},
		blocked: () => {
			const reports = Arr.map(Arr.fromIterable(inFlight.values()), (watch) => watch.report())
			return reports.length === 1
				? Arr.join(reports, "")
				: Arr.join(
						[
							`one of these ${reports.length} cases in flight blocked the process, and the watchdog cannot tell which:`,
							...reports
						],
						"\n\n"
					)
		}
	}
}

/** This process's watchdog, started the first time a case asks for it. */
const watchdogOfProcess = (): Watchdog => {
	globalThis.grizzleTestingWatchdog ??= isMainThread ? startedWatchdog() : offMainThread
	return globalThis.grizzleTestingWatchdog
}

/**
 * How long the main thread may go without answering the watchdog once a case in flight has passed its hang limit:
 * the hang limit again, and never less than HUNG_CLEANUP_GRACE, so a thread slowed by a loaded machine or a long
 * collection, which answers late, is never taken for one a loop holds.
 */
export const watchdogGrace = (caseHang: Duration.Input): Duration.Duration =>
	Duration.max(Duration.fromInputUnsafe(caseHang), HUNG_CLEANUP_GRACE)

/**
 * `effect`, a case, watched by the process's watchdog for as long as it runs: should it hold the main thread without
 * yielding for its hang limit and then watchdogGrace more, the process ends with `report`, the case's hang verdict, on
 * its stderr, since nothing on that thread can stop it. A case that yields is the guard's to stop at `caseHang`, and the
 * watchdog never acts on it.
 */
export const watchedCase = <A, E, R>(
	caseHang: Duration.Input,
	report: () => string,
	effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
	const hangMillis = Duration.toMillis(Duration.fromInputUnsafe(caseHang))
	const graceMillis = Duration.toMillis(watchdogGrace(caseHang))
	return Effect.acquireUseRelease(
		Effect.flatMap(liveMillis, (now) =>
			Effect.sync(() =>
				watchdogOfProcess().watch({ hangsAt: now + hangMillis, graceMillis, report })
			)
		),
		() => effect,
		(release) => Effect.sync(release)
	)
}
