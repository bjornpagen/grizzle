import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Exit, Formatter, Option } from "effect"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, boolean, element, type Gen, int } from "#gen.ts"
import {
	closed,
	guardHook,
	type Meter,
	opened,
	startedAt,
	waitingOnShared,
	workedBy
} from "#guard.ts"
import { liveSleep } from "#live.ts"
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

/** How a planted hook ends once its waits are over: with its value, with its own failure, or never, on its own work. */
type HookEnd = "builds" | "fails" | "hangs"

/**
 * A planted hook: its budget, its waits for a shared resource one after another, each lasting longer than the budget
 * on the live clock and some nested in a second wait, and how it ends. Its own work between them is a fiber's handful
 * of steps, far inside any budget, except a hook that hangs, whose own work never ends.
 */
type HookPlan = Readonly<{
	budgetMillis: number
	waits: ReadonlyArray<Readonly<{ millis: number; nested: boolean }>>
	end: HookEnd
}>

const HOOK_ENDS = ["builds", "fails", "hangs"] as const satisfies ReadonlyArray<HookEnd>

const hookPlan: Gen<HookPlan> = (source) => {
	const budgetMillis = source.draw(int(300, 500))
	return {
		budgetMillis,
		waits: source.draw(
			array(
				(inner) => ({
					millis: inner.draw(int(budgetMillis, 2 * budgetMillis)),
					nested: inner.draw(boolean)
				}),
				{ min: 0, max: 2 }
			)
		),
		end: source.draw(element(HOOK_ENDS))
	}
}

type HookFeature =
	| "a wait nested in another"
	| "waits past the budget in all"
	| "a hook that builds"
	| "a hook that fails"
	| "a hook that hangs"

const hookEndFeature = (end: HookEnd): HookFeature => {
	switch (end) {
		case "builds":
			return "a hook that builds"
		case "fails":
			return "a hook that fails"
		case "hangs":
			return "a hook that hangs"
	}
}

/** What a planted hook that builds returns. */
const BUILT = 7

/** A planted hook: each wait a sleep on the live clock marked as a wait for a shared resource, then its end. */
const plantedHook = (plan: HookPlan): Effect.Effect<number, string> =>
	Effect.andThen(
		Effect.forEach(
			plan.waits,
			(wait) =>
				wait.nested
					? liveSleep(Duration.millis(wait.millis)).pipe(waitingOnShared, waitingOnShared)
					: liveSleep(Duration.millis(wait.millis)).pipe(waitingOnShared),
			{ discard: true }
		),
		(): Effect.Effect<number, string> => {
			switch (plan.end) {
				case "builds":
					return Effect.succeed(BUILT)
				case "fails":
					return Effect.fail("refused")
				case "hangs":
					return Effect.never
			}
		}
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
						oracle: {
							kind: "second-implementation",
							name: "a model of the meter that counts the time no wait is open"
						},
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
		"ends a guarded hook as it ends, whatever it waits on others for, and with LayerHung once its own work outruns the budget",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "guard/hook",
						oracle: {
							kind: "specification",
							name: "the hook's own exit, or LayerHung with its label and budget when its own work never ends"
						},
						draw: drawn(hookPlan),
						literal: Formatter.format,
						coverage: required<HookFeature>(
							[
								"a wait nested in another",
								"waits past the budget in all",
								"a hook that builds",
								"a hook that fails",
								"a hook that hangs"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 6,
						shrink: { kind: "bounded", candidates: 8 },
						concurrency: 1,
						steerEvery: 6,
						caseHang: Duration.minutes(1)
					},
					(plan, c) =>
						Effect.gen(function* () {
							if (Arr.some(plan.waits, (wait) => wait.nested)) {
								c.note("a wait nested in another")
							}
							if (Arr.reduce(plan.waits, 0, (sum, wait) => sum + wait.millis) > plan.budgetMillis) {
								c.note("waits past the budget in all")
							}
							c.note(hookEndFeature(plan.end))
							const label = `a planted ${plan.end}`
							const exit = yield* Effect.exit(
								guardHook({ label, budgetMillis: plan.budgetMillis })(plantedHook(plan))
							)
							const failure = Exit.findErrorOption(exit)
							deepStrictEqual(
								{
									value: Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none(),
									own: Option.filter(failure, (failed) => typeof failed === "string"),
									hung: Option.flatMap(failure, (failed) =>
										typeof failed === "string"
											? Option.none()
											: Option.some({
													label: failed.label,
													budgetMillis: failed.budgetMillis,
													past: failed.workedMillis > failed.budgetMillis
												})
									)
								},
								{
									value: plan.end === "builds" ? Option.some(BUILT) : Option.none(),
									own: plan.end === "fails" ? Option.some("refused") : Option.none(),
									hung:
										plan.end === "hangs"
											? Option.some({ label, budgetMillis: plan.budgetMillis, past: true })
											: Option.none()
								}
							)
						})
				)
			)
	)
})
