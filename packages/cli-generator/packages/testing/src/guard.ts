import { Context, Effect, Fiber, Option, Ref, Schema } from "effect"
import { liveMillis, liveSleep, stopHung } from "#live.ts"

/**
 * A guard on a hook's own work: a layer's build, a setup or a teardown. Some waits in a hook are legal however long they
 * take, a wait for a resource other runs hold (a connection lease, a slot in a queue); some are a hang, a build stuck
 * on a server that never answers. A hook marks each wait for a shared resource with `waitingOnShared`, and the guard
 * counts only the time the hook spends outside every such wait, on the live clock: a hook whose own work outruns its
 * budget fails with LayerHung, its fiber stopped as a hung case's is, and a hook that waits on others for an hour
 * passes. Waits that overlap or nest are left out once: the hook is waiting while any of them is open.
 */
export class LayerHung extends Schema.TaggedError<LayerHung, { readonly brand: unique symbol }>()(
	"LayerHung",
	{
		label: Schema.String,
		budgetMillis: Schema.Int,
		workedMillis: Schema.Int
	}
) {}

/** A hook's work so far: the time worked before its current stretch, when the stretch began, and the waits open. */
export type Meter = Readonly<{ worked: number; since: number; waiting: number }>

/** A meter at `now`, nothing worked and no wait open. */
export const startedAt = (now: number): Meter => ({ worked: 0, since: now, waiting: 0 })

/** The meter as a wait for a shared resource opens at `now`: the stretch of work ends when the first one opens. */
export const opened = (meter: Meter, now: number): Meter =>
	meter.waiting === 0
		? { worked: meter.worked + (now - meter.since), since: now, waiting: 1 }
		: { ...meter, waiting: meter.waiting + 1 }

/** The meter as a wait closes at `now`: a stretch of work begins when the last one closes. */
export const closed = (meter: Meter, now: number): Meter =>
	meter.waiting === 1
		? { worked: meter.worked, since: now, waiting: 0 }
		: { ...meter, waiting: meter.waiting - 1 }

/** The time worked by `now`: the stretch in progress counts while no wait is open. */
export const workedBy = (meter: Meter, now: number): number =>
	meter.waiting === 0 ? meter.worked + (now - meter.since) : meter.worked

/** The meter of the guarded hook a fiber runs in, if it runs in one. */
const CurrentMeter = Context.Reference<Option.Option<Ref.Ref<Meter>>>(
	"@superstarter/testing/guard/CurrentMeter",
	{ defaultValue: () => Option.none() }
)

/** `effect` as a wait for a resource others hold: no guarded hook's budget runs during it. Outside a guard, `effect`. */
export const waitingOnShared = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.gen(function* () {
		const meter = yield* CurrentMeter
		return yield* Option.match(meter, {
			onNone: () => effect,
			onSome: (ref) =>
				Effect.acquireUseRelease(
					Effect.flatMap(liveMillis, (now) => Ref.update(ref, (m) => opened(m, now))),
					() => effect,
					() => Effect.flatMap(liveMillis, (now) => Ref.update(ref, (m) => closed(m, now)))
				)
		})
	})

/** How often the guard reads its meter: a twentieth of the budget, between 10 ms and a second. */
const tickOf = (budgetMillis: number) => Math.min(1000, Math.max(10, Math.floor(budgetMillis / 20)))

/**
 * `hook` guarded: its value or its failure as it ends, or LayerHung once its own work, the time outside every
 * `waitingOnShared`, passes `budgetMillis` on the live clock. The hook runs in a fiber of its own with the caller's
 * services, so the resources it acquires belong to the caller's scope, and an interrupted caller stops it.
 */
export const guardHook =
	(options: Readonly<{ label: string; budgetMillis: number }>) =>
	<A, E, R>(hook: Effect.Effect<A, E, R>): Effect.Effect<A, E | LayerHung, R> =>
		Effect.gen(function* () {
			const startMillis = yield* liveMillis
			const meter = yield* Ref.make(startedAt(startMillis))
			const running = yield* Effect.forkDetach(
				hook.pipe(Effect.provideService(CurrentMeter, Option.some(meter)))
			)
			const tick = tickOf(options.budgetMillis)
			const watch: Effect.Effect<number> = Effect.flatMap(liveSleep(tick), () =>
				Effect.flatMap(Effect.all([Ref.get(meter), liveMillis]), ([m, now]) =>
					workedBy(m, now) > options.budgetMillis ? Effect.succeed(workedBy(m, now)) : watch
				)
			)
			const ended = yield* Effect.raceFirst(
				Effect.map(Fiber.await(running), (exit) => ({ kind: "ended", exit }) as const),
				Effect.map(watch, (worked) => ({ kind: "hung", worked }) as const)
			).pipe(Effect.onInterrupt(() => stopHung(running)))
			if (ended.kind === "ended") {
				return yield* ended.exit
			}
			yield* stopHung(running)
			return yield* LayerHung.make({
				label: options.label,
				budgetMillis: options.budgetMillis,
				workedMillis: Math.round(ended.worked)
			})
		})
