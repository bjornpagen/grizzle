import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Deferred, Duration, Effect, Formatter, Option, Schema } from "effect"
import { drawn, explore } from "#explore.ts"
import { awaitFact } from "#fact.ts"
import { required } from "#features.ts"
import { array, element, type Gen, int } from "#gen.ts"
import {
	closed,
	guardHook,
	LayerHung,
	type Meter,
	opened,
	startedAt,
	waitingOnShared,
	workedBy
} from "#guard.ts"
import { liveMillis } from "#live.ts"
import { notesOnly } from "#sense.ts"
import { searched } from "#vitest/searched.ts"

/** A step of a hook's life: time passing, then a wait opening or closing, or nothing. */
type Step = Readonly<{ elapse: number; event: "open" | "close" | "none" }>

const stepGen: Gen<Step> = (source) => ({
	elapse: source.draw(int(0, 1000)),
	event: source.draw(element(["open", "close", "none"]))
})

type MeterFeature =
	| "a wait nested in another"
	| "work between two waits"
	| "a wait still open at the end"
	| "work after the last wait"

/** What a hook's steps worked, as the model counts it: the time that passed while no wait was open. */
const modelWorked = (steps: ReadonlyArray<Step>): number =>
	Arr.reduce(steps, { worked: 0, depth: 0 }, (state, step) => ({
		worked: state.depth === 0 ? state.worked + step.elapse : state.worked,
		depth:
			step.event === "open"
				? state.depth + 1
				: step.event === "close" && state.depth > 0
					? state.depth - 1
					: state.depth
	})).worked

/** The meter after the steps, from time 0: a close with no wait open closes nothing. */
const metered = (steps: ReadonlyArray<Step>): Readonly<{ meter: Meter; now: number }> =>
	Arr.reduce(steps, { meter: startedAt(0), now: 0 }, ({ meter, now }, step) => {
		const at = now + step.elapse
		if (step.event === "open") {
			return { meter: opened(meter, at), now: at }
		}
		if (step.event === "close" && meter.waiting > 0) {
			return { meter: closed(meter, at), now: at }
		}
		return { meter, now: at }
	})

const notes = (steps: ReadonlyArray<Step>, note: (feature: MeterFeature) => void): void => {
	let depth = 0
	let workedSinceWait = false
	let waited = false
	for (const step of steps) {
		if (depth === 0 && step.elapse > 0 && waited) {
			workedSinceWait = true
		}
		if (step.event === "open") {
			if (depth > 0) {
				note("a wait nested in another")
			}
			if (workedSinceWait) {
				note("work between two waits")
			}
			depth += 1
			waited = true
			workedSinceWait = false
		} else if (step.event === "close" && depth > 0) {
			depth -= 1
		}
	}
	note(depth > 0 ? "a wait still open at the end" : "work after the last wait")
}

/** The live clock has moved `millis` past `from`: a fact a concurrent fiber polls, never a sleep. */
const passed = (from: number, millis: number) =>
	awaitFact(
		Effect.map(liveMillis, (now) => (now - from > millis ? Option.some(now) : Option.none()))
	)

describe("a guarded hook", () => {
	it.effect(
		"counts exactly the time no wait for a shared resource is open, nested waits left out once",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "guard/meter",
						draw: drawn(array(stepGen, { min: 0, max: 12 })),
						literal: Formatter.format,
						coverage: required<MeterFeature>(
							[
								"a wait nested in another",
								"work between two waits",
								"a wait still open at the end",
								"work after the last wait"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: { kind: "bounded", candidates: 200 },
						concurrency: 1,
						steerEvery: 400,
						caseHang: Duration.seconds(10)
					},
					(steps, c) =>
						Effect.sync(() => {
							notes(steps, (feature) => c.note(feature))
							const { meter, now } = metered(steps)
							strictEqual(workedBy(meter, now), modelWorked(steps))
						})
				)
			)
	)

	it.effect(
		"fails with LayerHung, its label, budget and work, once a hung hook's own work outruns the budget",
		() =>
			Effect.gen(function* () {
				const hung = yield* Effect.flip(
					guardHook({ label: "a hung build", budgetMillis: 30 })(Effect.never)
				)
				deepStrictEqual(
					{ tag: hung._tag, label: hung.label, budgetMillis: hung.budgetMillis },
					{ tag: "LayerHung", label: "a hung build", budgetMillis: 30 }
				)
				strictEqual(
					hung.workedMillis > hung.budgetMillis ? "past its budget" : "within it",
					"past its budget"
				)
			})
	)

	it.effect(
		"passes a hook that waits on a shared resource for three times its budget, then builds",
		() =>
			Effect.gen(function* () {
				const released = yield* Deferred.make<void>()
				const started = yield* liveMillis
				yield* Effect.forkChild(
					Effect.andThen(passed(started, 90), Deferred.succeed(released, undefined))
				)
				const built = yield* Deferred.await(released).pipe(
					waitingOnShared,
					waitingOnShared,
					Effect.as("built"),
					guardHook({ label: "a build behind a lease", budgetMillis: 30 })
				)
				strictEqual(built, "built")
			})
	)

	it.effect("ends as the hook ends: its value, or its own failure", () =>
		Effect.gen(function* () {
			const guarded = guardHook({ label: "a build", budgetMillis: 1000 })
			const guardedValue = yield* guarded(Effect.succeed(7))
			strictEqual(guardedValue, 7)
			const refused = yield* Effect.flip(guarded(Effect.fail("refused")))
			strictEqual(refused, "refused")
			strictEqual(Schema.is(LayerHung)(refused) ? "hung" : "its own", "its own")
		})
	)
})
